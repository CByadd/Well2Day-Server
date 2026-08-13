const Razorpay = require('razorpay');
const crypto = require('crypto');

// Validate Razorpay credentials
const keyId = process.env.RAZORPAY_KEY_ID?.trim();
const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();

if (!keyId || !keySecret) {
  console.error('[RAZORPAY] WARNING: Razorpay credentials not configured!');
  console.error('[RAZORPAY] RAZORPAY_KEY_ID:', keyId ? 'SET' : 'MISSING');
  console.error('[RAZORPAY] RAZORPAY_KEY_SECRET:', keySecret ? 'SET' : 'MISSING');
} else {
  // Log key info without exposing secrets
  console.log('[RAZORPAY] Credentials loaded:');
  console.log('[RAZORPAY] Key ID:', keyId.substring(0, 10) + '...' + keyId.substring(keyId.length - 4));
  console.log('[RAZORPAY] Key Secret:', keySecret.substring(0, 4) + '...' + keySecret.substring(keySecret.length - 4));
  console.log('[RAZORPAY] Key Type:', keyId.startsWith('rzp_live_') ? 'LIVE' : keyId.startsWith('rzp_test_') ? 'TEST' : 'UNKNOWN');
}

// Initialize Razorpay instance
const razorpay = new Razorpay({
  key_id: keyId,
  key_secret: keySecret,
});

// ============================================
// PAYMENT IMPLEMENTATION (MOCK SUPPORT)
// ============================================
const MOCK_PAYMENT_MODE = process.env.MOCK_PAYMENT_MODE === 'true'; 

// In-memory store for orders (for verification and notes retrieval)
const orderStore = new Map();

if (MOCK_PAYMENT_MODE) {
  console.log('[PAYMENT] 🧪 MOCK PAYMENT MODE ENABLED');
  console.log('[PAYMENT] 🧪 All payments will be automatically approved');
} else {
  console.log('[PAYMENT] 💳 RAZORPAY LIVE MODE ENABLED');
}

/**
 * POST /api/payment/create-order
 * Create a payment order
 */
exports.createOrder = async (req, res, io) => {
  try {
    const { amount, currency = 'INR', receipt, notes } = req.body;

    // Notify the kiosk the instant the customer's phone starts checkout, so the
    // QR screen can switch from "scan" to "payment processing" — without this
    // there is no signal to Android between order creation and payment-success,
    // so the kiosk shows nothing while the customer is actively paying.
    const notifyProcessing = () => {
      const screenId = notes?.screenId;
      if (screenId && io) {
        io.to(`screen:${String(screenId)}`).emit('payment-processing', {
          screenId: String(screenId),
          bmiId: notes?.bmiId || null,
          userId: notes?.userId || null
        });
      }
    };

    // Validate amount
    if (amount === null || amount === undefined || amount === '') {
      return res.status(400).json({ 
        error: 'Amount is required',
        details: 'Please provide a valid payment amount'
      });
    }

    // Convert to number and validate
    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ 
        error: 'Invalid amount',
        details: `Amount must be a positive number. Received: ${amount}`
      });
    }

    // Minimum amount is 1 INR
    if (amountNum < 1) {
      return res.status(400).json({ 
        error: 'Amount too small',
        details: 'Minimum payment amount is ₹1'
      });
    }

    // Convert amount to paise (smallest currency unit for INR)
    const amountInPaise = Math.round(amountNum * 100);
    const receiptValue = receipt || `rcpt${Date.now()}`;

    if (MOCK_PAYMENT_MODE) {
      console.log('[PAYMENT] 🧪 MOCK: Create order request:', { amount, currency, receipt, notes });
      
      // Generate mock order ID
      const mockOrderId = `order_mock_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

      // Store order in memory for verification
      orderStore.set(mockOrderId, {
        amount: amountInPaise,
        currency: currency,
        receipt: receiptValue,
        notes: notes || {},
        createdAt: Date.now(),
        status: 'created'
      });

      console.log('[PAYMENT] 🧪 MOCK: Order created successfully:', mockOrderId);
      notifyProcessing();

      return res.json({
        ok: true,
        order: {
          id: mockOrderId,
          amount: amountInPaise,
          currency: currency,
          receipt: receiptValue,
          status: 'created',
        },
        mockMode: true
      });
    } else {
      console.log('[RAZORPAY] Create order request:', { amount, currency, receipt, notes });
      
      const options = {
        amount: amountInPaise,
        currency: currency,
        receipt: receiptValue,
        notes: notes || {}
      };

      const order = await razorpay.orders.create(options);
      
      // Store order in memory to retrieve notes later during verification
      orderStore.set(order.id, {
        amount: order.amount,
        currency: order.currency,
        receipt: order.receipt,
        notes: order.notes || {},
        createdAt: Date.now(),
        status: order.status
      });

      console.log('[RAZORPAY] Order created successfully:', order.id);
      notifyProcessing();

      return res.json({
        ok: true,
        order: order,
        mockMode: false
      });
    }
  } catch (error) {
    console.error('[PAYMENT] Create order error:', error);
    res.status(500).json({
      error: 'Failed to create order',
      message: error.message,
    });
  }
};

/**
 * POST /api/payment/verify
 * Verify payment
 * Also triggers payment success notification to Android if bmiId and userId are in order notes
 */
exports.verifyPayment = async (req, res, io, bmiFlowController) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const paymentVerifyTime = new Date().toISOString();

    // ========== PAYMENT FLOW LOGGING - PAYMENT VERIFICATION ==========
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('[PAYMENT_FLOW] 🔐 PAYMENT VERIFICATION STARTED');
    console.log('[PAYMENT_FLOW] Timestamp:', paymentVerifyTime);
    console.log('[PAYMENT_FLOW] Order ID:', razorpay_order_id);
    console.log('[PAYMENT_FLOW] Payment ID:', razorpay_payment_id);
    console.log('[PAYMENT_FLOW] Request IP:', req.ip || req.connection.remoteAddress);
    console.log('═══════════════════════════════════════════════════════════════');

    if (!razorpay_order_id || !razorpay_payment_id) {
      return res.status(400).json({
        error: 'Missing required payment verification fields',
      });
    }

    let isVerified = false;

    if (MOCK_PAYMENT_MODE) {
      console.log('[PAYMENT] 🧪 MOCK: Simple mock mode - accepting all payments');
      isVerified = true;
    } else {
      // Real Razorpay signature verification
      const text = `${razorpay_order_id}|${razorpay_payment_id}`;
      const generatedSignature = crypto
        .createHmac('sha256', keySecret)
        .update(text)
        .digest('hex');
      
      isVerified = generatedSignature === razorpay_signature;
      console.log('[RAZORPAY] Signature verification:', isVerified ? 'SUCCESS' : 'FAILED');
    }

    if (!isVerified) {
      return res.status(400).json({
        ok: false,
        verified: false,
        error: 'Invalid payment signature'
      });
    }

    // Automatically trigger payment success notification to Android after payment verification
    console.log('[PAYMENT_FLOW] Checking if order exists in store:', razorpay_order_id, 'Exists:', orderStore.has(razorpay_order_id));
    
    if (orderStore.has(razorpay_order_id) && io && bmiFlowController) {
      const order = orderStore.get(razorpay_order_id);
      console.log('[PAYMENT_FLOW] Order found in store:', JSON.stringify(order, null, 2));
      const notes = order.notes || {};
      const userId = notes.userId;
      const screenId = notes.screenId;
      let bmiId = notes.bmiId;
      
      // If bmiId is not in notes, try to find the most recent unlinked BMI record for this screen
      if (!bmiId && userId && screenId) {
        try {
          const prisma = require('../db');
          const recentBMI = await prisma.bMI.findFirst({
            where: {
              screenId: String(screenId),
              userId: null // Not yet linked to a user
            },
            orderBy: {
              timestamp: 'desc'
            }
          });
          
          if (recentBMI) {
            bmiId = recentBMI.id;
            console.log('[PAYMENT] Found recent BMI record for screen:', screenId, 'bmiId:', bmiId);
          }
        } catch (dbError) {
          console.error('[PAYMENT] Error finding BMI record for auto-notification:', dbError);
        }
      }
      
      // Trigger payment success notification if we have both userId and bmiId
      if (bmiId && userId) {
        console.log('[PAYMENT_FLOW] 🔔 Auto-triggering payment success notification');
        try {
          const paymentAmountInRupees = order.amount ? order.amount / 100 : null;
          
          const mockReq = {
            body: {
              userId: userId,
              bmiId: bmiId,
              appVersion: 'f1', // Default to f1
              paymentAmount: paymentAmountInRupees
            }
          };
          
          const mockRes = {
            json: (data) => {
              console.log('[PAYMENT_FLOW] ✅ Payment success notification triggered successfully');
            },
            status: (code) => ({ json: (data) => {
              console.log('[PAYMENT_FLOW] ❌ Payment success notification failed:', code);
            }})
          };
          await bmiFlowController.paymentSuccess(mockReq, mockRes, io);
        } catch (notifyError) {
          console.error('[PAYMENT] Error auto-triggering payment success notification:', notifyError);
        }
      }
    }

    console.log('[PAYMENT_FLOW] ✅ Payment verification completed successfully');

    return res.json({
      ok: true,
      verified: true,
      payment_id: razorpay_payment_id,
      order_id: razorpay_order_id,
      mockMode: MOCK_PAYMENT_MODE
    });

  } catch (error) {
    console.error('[PAYMENT] Verify payment error:', error);
    res.status(500).json({
      error: 'Failed to verify payment',
      message: error.message,
    });
  }
};

/**
 * GET /api/payment/key
 * Get payment key
 */
exports.getKey = (req, res) => {
  try {
    if (MOCK_PAYMENT_MODE) {
      const mockKeyId = 'rzp_mock_' + Math.random().toString(36).substring(2, 15);
      return res.json({
        ok: true,
        key_id: mockKeyId,
        mockMode: true
      });
    }

    if (!keyId) {
      return res.status(500).json({
        error: 'Razorpay key not configured',
      });
    }
    
    res.json({
      ok: true,
      key_id: keyId,
      mockMode: false
    });
  } catch (error) {
    console.error('[PAYMENT] Get key error:', error);
    res.status(500).json({
      error: 'Failed to get payment key',
      message: error.message,
    });
  }
};
