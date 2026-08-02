const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { sendBulkSms } = require('../services/routeMobileService');
const { sendWellTemplate } = require('../services/convoboxWhatsAppService');

// In-memory store for BMI data
const bmiStore = new Map(); // bmiId -> payload

async function ensureWebLinkExpiryColumn() {
    try {
        await prisma.$executeRawUnsafe(`
            ALTER TABLE "BMI"
            ADD COLUMN IF NOT EXISTS "webLinkExpired" BOOLEAN DEFAULT false
        `);
    } catch (error) {
        console.warn('[BMI] Failed to ensure webLinkExpired column:', error.message);
    }
}

async function getWebLinkExpiredFlag(bmiId) {
    await ensureWebLinkExpiryColumn();
    try {
        const rows = await prisma.$queryRawUnsafe(
            `SELECT COALESCE("webLinkExpired", false) AS "webLinkExpired" FROM "BMI" WHERE id = $1::uuid LIMIT 1`,
            bmiId
        );
        return Boolean(rows?.[0]?.webLinkExpired);
    } catch (error) {
        console.warn('[BMI] Failed to read webLinkExpired flag:', error.message);
        return false;
    }
}

/**
 * Generate fortune message using Grok API
 */
async function generateFortuneMessage(bmiData) {
  try {
    const grokApiKey = process.env.GROK_API_KEY;
    if (!grokApiKey) {
      console.log('[GROK] No API key found, using fallback message');
      return generateFallbackFortune(bmiData);
    }

    const prompt = bmiData?.isHeightValid
      ? `Generate a positive, motivational fortune cookie message for someone with BMI ${bmiData.bmi} (${bmiData.category}). Keep it short (1-2 sentences), uplifting, and health-focused. Don't mention specific BMI numbers.`
      : `Generate a positive, motivational health message for someone who has just completed a weight check. Keep it short (1-2 sentences), uplifting, and focused on healthy habits. Do not mention BMI.`;
    
    const response = await axios.post('https://api.x.ai/v1/chat/completions', {
      model: 'grok-beta',
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 100,
      temperature: 0.8
    }, {
      headers: {
        'Authorization': `Bearer ${grokApiKey}`,
        'Content-Type': 'application/json'
      }
    });

    const message = response.data.choices[0]?.message?.content?.trim();
    return message || generateFallbackFortune(bmiData);
  } catch (error) {
    console.error('[GROK] API error:', error.message);
    return generateFallbackFortune(bmiData);
  }
}

/**
 * Generate fallback fortune message
 */
function generateFallbackFortune(bmiData) {
  const fortunes = [
    "Your journey to wellness is a beautiful adventure. Every step forward is progress worth celebrating.",
    "Health is not just about numbers, but about feeling strong and confident in your own skin.",
    "Small, consistent changes lead to big transformations. You're already on the right path.",
    "Your body is your temple. Treat it with love, respect, and gentle care every day.",
    "Wellness is a journey, not a destination. Enjoy the process of becoming your best self.",
    "Every healthy choice you make is an investment in your future happiness and vitality.",
    "Your commitment to health shows incredible self-love. Keep nurturing that beautiful spirit.",
    "Balance is the key to lasting wellness. Listen to your body and honor its wisdom."
  ];
  
  return fortunes[Math.floor(Math.random() * fortunes.length)];
}

/**
 * Compute BMI helper
 */
function computeBMI(heightCm, weightKg) {
	const h = Number(heightCm);
	const w = Number(weightKg);
	if (!h || !w) return { bmi: null, category: 'invalid' };
	const heightM = h / 100;
	const bmi = Number((w / (heightM * heightM)).toFixed(1));
	let category = 'Normal';
	if (bmi < 18.5) category = 'Underweight';
	else if (bmi < 25) category = 'Normal';
	else if (bmi < 30) category = 'Overweight';
	else category = 'Obese';
	return { bmi, category };
}

/**
 * Calculate streak helper
 */
function calculateStreak(bmiRecords) {
    if (!bmiRecords || bmiRecords.length === 0) return { currentStreak: 0, longestStreak: 0, isActive: false };
    
    // Sort records by date (newest first)
    const sortedRecords = bmiRecords.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    let currentStreak = 0;
    let longestStreak = 0;
    let tempStreak = 0;
    let isActive = false;
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Group records by date (ignore time)
    const recordsByDate = new Map();
    sortedRecords.forEach(record => {
        const dateKey = new Date(record.timestamp);
        dateKey.setHours(0, 0, 0, 0);
        const dateString = dateKey.toISOString().split('T')[0];
        if (!recordsByDate.has(dateString)) {
            recordsByDate.set(dateString, record);
        }
    });
    
    const uniqueDates = Array.from(recordsByDate.keys()).sort().reverse();
    
    if (uniqueDates.length === 0) return { currentStreak: 0, longestStreak: 0, isActive: false };
    
    // Check if most recent record is today or yesterday
    const mostRecentDate = new Date(uniqueDates[0]);
    const daysDiff = Math.floor((today - mostRecentDate) / (1000 * 60 * 60 * 24));
    
    if (daysDiff <= 1) {
        isActive = true;
        currentStreak = 1;
        
        // Calculate current streak
        for (let i = 1; i < uniqueDates.length; i++) {
            const currentDate = new Date(uniqueDates[i]);
            const prevDate = new Date(uniqueDates[i - 1]);
            const diff = Math.floor((prevDate - currentDate) / (1000 * 60 * 60 * 24));
            
            if (diff === 1) {
                currentStreak++;
            } else {
                break;
            }
        }
    }
    
    // Calculate longest streak
    tempStreak = 1;
    longestStreak = 1;
    
    for (let i = 1; i < uniqueDates.length; i++) {
        const currentDate = new Date(uniqueDates[i]);
        const prevDate = new Date(uniqueDates[i - 1]);
        const diff = Math.floor((prevDate - currentDate) / (1000 * 60 * 60 * 24));
        
        if (diff === 1) {
            tempStreak++;
        } else {
            longestStreak = Math.max(longestStreak, tempStreak);
            tempStreak = 1;
        }
    }
    longestStreak = Math.max(longestStreak, tempStreak);
    
    return { currentStreak, longestStreak, isActive };
}

/**
 * POST /api/bmi -> { heightCm, weightKg, screenId, appVersion }
 * Create BMI record
 */
exports.createBMI = async (req, res, io) => {
    try {
		const { heightCm, weightKg, screenId, appVersion, fortune: bodyFortune, healthTip: bodyHealthTip } = req.body || {};
        const parsedHeightCm = Number(heightCm || 0);
        const parsedWeightKg = Number(weightKg);
        const isHeightValid = Number.isFinite(parsedHeightCm) && parsedHeightCm > 0;
		const flowStartTime = new Date().toISOString();
		
		// ========== PAYMENT FLOW LOGGING - FLOW STARTED (SERVER) ==========
		console.log('═══════════════════════════════════════════════════════════════');
		console.log('[PAYMENT_FLOW] 🚀 FLOW TRIGGERED - START (SERVER)');
		console.log('[PAYMENT_FLOW] Timestamp:', flowStartTime);
		console.log('[PAYMENT_FLOW] Screen ID:', screenId);
		console.log('[PAYMENT_FLOW] Weight:', weightKg, 'kg');
		console.log('[PAYMENT_FLOW] Height:', heightCm, 'cm');
		console.log('[PAYMENT_FLOW] App Version:', appVersion);
		console.log('[PAYMENT_FLOW] Request IP:', req.ip || req.connection.remoteAddress);
		console.log('═══════════════════════════════════════════════════════════════');
		
		if (!parsedWeightKg || !screenId) {
			console.log('[PAYMENT_FLOW] ❌ Validation failed - missing required fields');
			return res.status(400).json({ error: 'weightKg and screenId required' });
		}
		
		// Get the registered player's flow type from database
		let playerFlowType = null;
		try {
			const player = await prisma.adscapePlayer.findUnique({
				where: { screenId: String(screenId) }
			});
			playerFlowType = player?.flowType;
			console.log('[BMI] Player flow type from DB:', playerFlowType, 'for screenId:', screenId);
		} catch (e) {
			console.log('[BMI] Could not fetch player flow type:', e.message);
		}
		
		const { bmi, category } = isHeightValid
            ? computeBMI(parsedHeightCm, parsedWeightKg)
            : { bmi: null, category: 'weight_only' };
		const bmiId = uuidv4();
		const timestamp = new Date().toISOString();
		// Fortune: use client-provided (Android local pick) when present, else generate for F2, else null for F1/F3
        const effectiveFlowType = playerFlowType || appVersion;
        const clientFortune = (bodyFortune != null && String(bodyFortune).trim()) ? String(bodyFortune).trim() : null;
        const fortune = clientFortune ?? ((effectiveFlowType === 'F2' || effectiveFlowType === 'f2') ? await generateFortuneMessage({ bmi, category, isHeightValid }) : null);
        const healthTip = (bodyHealthTip != null && String(bodyHealthTip).trim()) ? String(bodyHealthTip).trim() : null;
        console.log('[BMI] Effective flow type:', effectiveFlowType, 'fortune:', clientFortune ? 'from client' : !!fortune, 'healthTip:', !!healthTip);
        
		const payload = {
			bmiId,
			screenId: String(screenId),
			height: isHeightValid ? parsedHeightCm : 0,
			weight: parsedWeightKg,
			bmi,
			category: isHeightValid ? category : 'Weight Only',
			timestamp,
            isHeightValid,
			fortune
		};
        bmiStore.set(bmiId, payload);

        // Upsert Screen and create BMI record
        await prisma.screen.upsert({
            where: { id: String(screenId) },
            create: { id: String(screenId) },
            update: {}
        });
        
        await prisma.bMI.create({
            data: {
                id: bmiId,
                screenId: String(screenId),
                heightCm: isHeightValid ? parsedHeightCm : 0,
                weightKg: parsedWeightKg,
                bmi: bmi != null ? Number(bmi) : 0,
                category: isHeightValid ? category : 'Weight Only',
                timestamp: new Date(timestamp),
                deviceId: req.body.deviceId || null,
                appVersion: appVersion || null,
                location: req.body.location || null,
                fortune: fortune,
                healthTip: healthTip
            }
        });

		// Build web client URL (adjust if you host client elsewhere)
		const clientBase = process.env.CLIENT_BASE_URL || 'https://app.well2day.in';
		// Provide API base in URL hash so SPA can call backend even when hosted elsewhere
		const inferredProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0] || req.protocol;
		const apiBase = process.env.API_PUBLIC_BASE || `${inferredProto}://${req.get('host')}`;
		// Use effective flow type for web URL (convert to lowercase for client compatibility)
		const version = (effectiveFlowType || appVersion || 'f1').toLowerCase();
		const webUrl = `${clientBase}?screenId=${encodeURIComponent(String(screenId))}&bmiId=${encodeURIComponent(bmiId)}&appVersion=${encodeURIComponent(version)}#server=${encodeURIComponent(apiBase)}`;

        // ========== PAYMENT FLOW LOGGING - BMI CREATED (SERVER) ==========
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('[PAYMENT_FLOW] ✅ BMI RECORD CREATED (SERVER)');
        console.log('[PAYMENT_FLOW] BMI ID:', bmiId);
        console.log('[PAYMENT_FLOW] BMI:', bmi, '(', isHeightValid ? category : 'Weight Only', ')');
        console.log('[PAYMENT_FLOW] Web URL:', webUrl);
        console.log('[PAYMENT_FLOW] Effective Flow Type:', effectiveFlowType);
        console.log('[PAYMENT_FLOW] Fortune Generated:', !!fortune);
        console.log('[PAYMENT_FLOW] Waiting for payment...');
        console.log('═══════════════════════════════════════════════════════════════');

        // Emit to the Android player room so it can open a modal
        const emitPayload = {
            ...payload,
            webUrl
        };
        if (io) {
            io.to(`screen:${String(screenId)}`).emit('bmi-data-received', emitPayload);
            console.log('[PAYMENT_FLOW] 📡 Emitted bmi-data-received to screen:', screenId);
        }
        console.log('[BMI] created and emitted', emitPayload);

		return res.status(201).json({ ok: true, bmiId, webUrl });
    } catch (e) {
        console.error('[BMI] POST /api/bmi error', e);
		return res.status(500).json({ error: 'internal_error' });
	}
};

/**
 * POST /api/user -> { name, gender, age, mobile } -> create new user
 * Returns error if user already exists
 */
exports.createUser = async (req, res) => {
    try {
        const { name, gender, age, mobile } = req.body || {};
        if (!name || !mobile) {
            return res.status(400).json({ error: 'name, mobile required' });
        }
        
        // Check if user already exists
        const existingUser = await prisma.user.findFirst({
            where: { mobile: String(mobile) }
        });
        
        if (existingUser) {
            return res.status(409).json({ error: 'User already exists with this mobile number. Please login instead.' });
        }
        
        // Create new user
        const user = await prisma.user.create({
            data: {
                name: String(name),
                mobile: String(mobile),
                gender: gender ? String(gender) : null,
                age: age ? parseInt(age) : null
            }
        });
        
        return res.json({ userId: user.id, name: user.name, mobile: user.mobile, gender: user.gender, age: user.age });
    } catch (e) {
        console.error('[USER] POST /api/user error', e);
        if (e.code === 'P2002') {
            // Prisma unique constraint violation
            return res.status(409).json({ error: 'User already exists with this mobile number. Please login instead.' });
        }
        return res.status(500).json({ error: 'internal_error' });
    }
};

/**
 * POST /api/user/login -> { mobile } -> find user by mobile
 * Returns error if user doesn't exist
 */
exports.loginUser = async (req, res) => {
    try {
        const { mobile } = req.body || {};
        if (!mobile) {
            return res.status(400).json({ error: 'mobile required' });
        }
        
        // Find user by mobile
        const user = await prisma.user.findFirst({
            where: { mobile: String(mobile) }
        });
        
        if (!user) {
            return res.status(404).json({ error: 'User not found. Please create an account first.' });
        }
        
        return res.json({ userId: user.id, name: user.name, mobile: user.mobile, gender: user.gender, age: user.age });
    } catch (e) {
        console.error('[USER] POST /api/user/login error', e);
        return res.status(500).json({ error: 'internal_error' });
    }
};

/**
 * POST /api/payment-success -> { userId, bmiId } -> link user to BMI and emit to Android
 */
exports.paymentSuccess = async (req, res, io) => {
    try {
        const { userId, bmiId, appVersion, paymentToken, paymentAmount: paymentAmountFromRequest } = req.body || {};
        const paymentReceivedTime = new Date().toISOString();
        
        // ========== PAYMENT FLOW LOGGING - PAYMENT RECEIVED (SERVER) ==========
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('[PAYMENT_FLOW] 💰 PAYMENT COMPLETED - INFO RECEIVED (SERVER)');
        console.log('[PAYMENT_FLOW] Timestamp:', paymentReceivedTime);
        console.log('[PAYMENT_FLOW] BMI ID:', bmiId);
        console.log('[PAYMENT_FLOW] User ID:', userId);
        console.log('[PAYMENT_FLOW] App Version:', appVersion);
        console.log('[PAYMENT_FLOW] Payment Token:', paymentToken || 'Not provided');
        console.log('[PAYMENT_FLOW] Payment Amount (from request):', paymentAmountFromRequest);
        console.log('[PAYMENT_FLOW] Full request body:', JSON.stringify(req.body, null, 2));
        console.log('[PAYMENT_FLOW] Request IP:', req?.ip ?? req?.connection?.remoteAddress ?? 'N/A');
        console.log('═══════════════════════════════════════════════════════════════');
        
        if (!userId || !bmiId) {
            console.log('[PAYMENT_FLOW] ❌ Validation failed - missing userId or bmiId');
            return res.status(400).json({ error: 'userId, bmiId required' });
        }
        
        // Get BMI record first to get screenId
        const bmiRecord = await prisma.bMI.findUnique({
            where: { id: bmiId },
            select: { screenId: true }
        });
        
        if (!bmiRecord) {
            return res.status(404).json({ error: 'BMI record not found' });
        }
        
        // Default payment amount (same as PaymentPage default) - only used if amount not provided from frontend
        const DEFAULT_PAYMENT_AMOUNT = 9;
        
        // Use payment amount from request (actual amount paid by user from frontend payment confirmation)
        // Don't rely on screen config - store the actual amount paid
        let paymentAmount = null;
        if (paymentAmountFromRequest !== null && paymentAmountFromRequest !== undefined) {
            paymentAmount = parseFloat(paymentAmountFromRequest);
            if (!isNaN(paymentAmount) && paymentAmount > 0) {
                console.log('[PAYMENT_FLOW] Using payment amount from frontend (actual amount paid):', paymentAmount);
            } else {
                paymentAmount = null;
                console.log('[PAYMENT_FLOW] Payment amount from request is invalid');
            }
        }
        
        // If payment amount not provided from frontend, use default (don't rely on screen config)
        if (paymentAmount === null || paymentAmount === undefined || isNaN(paymentAmount) || paymentAmount <= 0) {
            paymentAmount = DEFAULT_PAYMENT_AMOUNT;
            console.log('[PAYMENT_FLOW] Payment amount not provided from frontend, using default:', paymentAmount);
        }
        
        console.log('[PAYMENT_FLOW] Final payment amount to be saved:', paymentAmount);
        
        // Update BMI record with user, payment status, and payment amount using raw SQL to handle new columns
        // Use ::uuid casts so PostgreSQL compares uuid = uuid (params are passed as text otherwise)
        try {
            await prisma.$executeRawUnsafe(
                `UPDATE "BMI" SET "userId" = $1::uuid, "paymentStatus" = true, "paymentAmount" = $2 WHERE id = $3::uuid`,
                userId,
                paymentAmount,
                bmiId
            );
            console.log('[PAYMENT_FLOW] ✅ BMI record updated successfully with payment amount:', paymentAmount);
        } catch (e) {
            // If columns don't exist, create them first
            if (e.code === '42703' || e.message?.includes('does not exist')) {
                console.log('[PAYMENT_FLOW] Payment columns do not exist, creating them...');
                try {
                    // Create paymentStatus column if it doesn't exist
                    await prisma.$executeRawUnsafe(`
                        ALTER TABLE "BMI" 
                        ADD COLUMN IF NOT EXISTS "paymentStatus" BOOLEAN DEFAULT false
                    `);
                    console.log('[PAYMENT_FLOW] ✅ Created paymentStatus column');
                    
                    // Create paymentAmount column if it doesn't exist
                    await prisma.$executeRawUnsafe(`
                        ALTER TABLE "BMI" 
                        ADD COLUMN IF NOT EXISTS "paymentAmount" DOUBLE PRECISION
                    `);
                    console.log('[PAYMENT_FLOW] ✅ Created paymentAmount column');
                    
                    // Now try the update again (::uuid casts avoid "uuid = text" operator error)
                    await prisma.$executeRawUnsafe(
                        `UPDATE "BMI" SET "userId" = $1::uuid, "paymentStatus" = true, "paymentAmount" = $2 WHERE id = $3::uuid`,
                        userId,
                        paymentAmount,
                        bmiId
                    );
                    console.log('[PAYMENT_FLOW] ✅ BMI record updated successfully with payment amount after creating columns:', paymentAmount);
                } catch (createError) {
                    console.error('[PAYMENT_FLOW] Error creating columns or updating:', createError);
                    // Fallback to Prisma update (will fail if columns don't exist in schema)
                    try {
                        await prisma.bMI.update({
                            where: { id: bmiId },
                            data: {
                                userId: userId,
                                paymentStatus: true,
                                paymentAmount: paymentAmount
                            }
                        });
                        console.log('[PAYMENT_FLOW] ✅ BMI record updated using Prisma after column creation');
                    } catch (prismaError) {
                        console.error('[PAYMENT_FLOW] ❌ Error updating BMI record with Prisma:', prismaError);
                        throw prismaError;
                    }
                }
            } else {
                console.error('[PAYMENT_FLOW] ❌ Error updating BMI record:', e);
                throw e;
            }
        }
        
        // Fetch updated BMI record and verify payment amount was saved
        let updatedBMI;
        try {
            updatedBMI = await prisma.bMI.findUnique({
                where: { id: bmiId },
                include: { user: true, screen: true }
            });
        } catch (e) {
            // If Prisma can't find it (columns might not exist in Prisma schema), use raw SQL
            console.log('[PAYMENT_FLOW] Prisma findUnique failed, using raw SQL to verify...');
            const verifyResult = await prisma.$queryRawUnsafe(
                `SELECT id, "userId", "paymentStatus", "paymentAmount" FROM "BMI" WHERE id = $1::uuid LIMIT 1`,
                bmiId
            );
            if (verifyResult && verifyResult.length > 0) {
                const record = verifyResult[0];
                console.log('[PAYMENT_FLOW] ✅ Verified payment amount saved:', {
                    bmiId: record.id,
                    userId: record.userId,
                    paymentStatus: record.paymentStatus,
                    paymentAmount: record.paymentAmount
                });
                // Create a mock object for compatibility
                updatedBMI = {
                    id: record.id,
                    userId: record.userId,
                    paymentStatus: record.paymentStatus,
                    paymentAmount: record.paymentAmount,
                    user: null,
                    screen: null
                };
            } else {
                return res.status(404).json({ error: 'BMI record not found after update' });
            }
        }
        
        if (!updatedBMI) {
            return res.status(404).json({ error: 'BMI record not found after update' });
        }
        
        console.log('[PAYMENT_FLOW] ✅ BMI record updated with user:', updatedBMI.user?.name || 'Unknown');
        console.log('[PAYMENT_FLOW] User Details:', {
            userId: updatedBMI.userId,
            userName: updatedBMI.user?.name,
            userMobile: updatedBMI.user?.mobile
        });
        console.log('[PAYMENT_FLOW] ✅ Payment Details Saved:', {
            paymentStatus: updatedBMI.paymentStatus,
            paymentAmount: updatedBMI.paymentAmount
        });
        
        // Normalize appVersion for consistent comparison (case-insensitive)
        const normalizedAppVersion = appVersion ? String(appVersion).toLowerCase() : '';
        
        // Generate fortune only when not already set (e.g. Android sent locally-picked fortune at create)
        if (normalizedAppVersion !== 'f2') {
            const existingFortune = (updatedBMI.fortune != null && String(updatedBMI.fortune).trim()) ? String(updatedBMI.fortune).trim() : null;
            if (!existingFortune) {
                console.log('[PAYMENT] F1/F3 Flow: Generating fortune (appVersion:', appVersion, ')');
                const fortuneMessage = await generateFortuneMessage({
                    bmi: updatedBMI.bmi,
                    category: updatedBMI.category
                });
                await prisma.bMI.update({
                    where: { id: bmiId },
                    data: { fortune: fortuneMessage }
                });
                console.log('[PAYMENT] F1/F3 Flow: Fortune generated and stored:', fortuneMessage);
            } else {
                console.log('[PAYMENT] F1/F3 Flow: Fortune already set (from client), keeping:', existingFortune.slice(0, 50) + '...');
            }
        }

        // Re-fetch BMI so we have latest fortune and healthTip for WhatsApp template
        updatedBMI = await prisma.bMI.findUnique({
            where: { id: bmiId },
            include: { user: true, screen: true }
        });
        if (!updatedBMI) {
            return res.status(404).json({ error: 'BMI record not found after update' });
        }

        // Send post-payment SMS if enabled for this screen and within limit
        // Template placeholders: {{weight}}, {{bmi}}, {{url}}
        const postPaymentSmsTemplate = process.env.POST_PAYMENT_SMS_TEMPLATE ||
            'Dear User,\n\nYour weight is {{weight}} kg & your BMI is {{bmi}}. For more details, visit {{url}}.\nThanks for visiting.\n\nTeam Well2Day';
        const visitUrl = process.env.POST_PAYMENT_VISIT_URL || process.env.APP_URL || 'https://well2day.in';
        const buildPostPaymentMessage = (template, weightKg, bmi) => {
            return String(template)
                .replace(/\{\{weight\}\}/g, weightKg != null ? Number(weightKg) : '')
                .replace(/\{\{bmi\}\}/g, bmi != null ? Number(bmi) : '')
                .replace(/\{\{url\}\}/g, visitUrl)
                .replace(/\n/g, ' ') // Replace newlines with spaces for SMS
                .replace(/\r/g, '') // Remove carriage returns
                .replace(/\s+/g, ' ') // Replace multiple spaces with single space
                .trim(); // Remove leading/trailing spaces
        };
        try {
            await prisma.$executeRawUnsafe(
                `ALTER TABLE "AdscapePlayer" ADD COLUMN IF NOT EXISTS "smsEnabled" BOOLEAN DEFAULT false`
            );
            await prisma.$executeRawUnsafe(
                `ALTER TABLE "AdscapePlayer" ADD COLUMN IF NOT EXISTS "smsLimitPerScreen" INTEGER`
            );
            await prisma.$executeRawUnsafe(
                `ALTER TABLE "AdscapePlayer" ADD COLUMN IF NOT EXISTS "smsSentCount" INTEGER DEFAULT 0`
            );
            const smsConfigRows = await prisma.$queryRawUnsafe(
                `SELECT "smsEnabled", "smsLimitPerScreen", "smsSentCount" FROM "AdscapePlayer" WHERE "screenId" = $1 LIMIT 1`,
                updatedBMI.screenId
            );
            const smsConfig = smsConfigRows && smsConfigRows[0] ? smsConfigRows[0] : null;
            console.log('[PAYMENT_FLOW] SMS Config:', { 
                exists: !!smsConfig, 
                smsEnabled: smsConfig?.smsEnabled, 
                limit: smsConfig?.smsLimitPerScreen, 
                sent: smsConfig?.smsSentCount,
                screenId: updatedBMI.screenId 
            });
            // SMS: enabled when (1) screen is not assigned to any admin — super admin can enable for those screens,
            // or (2) at least one assigned admin has totalMessageLimit > 0 (super admin has set a limit for that admin).
            let smsAllowedByAdmin = true;
            let assignedAdmins = [];
            try {
                const adminLimitRows = await prisma.$queryRawUnsafe(
                    `SELECT au.id, au."totalMessageLimit", COALESCE(au."smsUsedCount", 0) as "smsUsedCount" FROM "AdminScreenAssignment" asa JOIN "AdminUser" au ON au.id = asa."adminId" WHERE asa."screenId" = $1`,
                    updatedBMI.screenId
                );
                if (Array.isArray(adminLimitRows) && adminLimitRows.length > 0) {
                    assignedAdmins = adminLimitRows;
                    smsAllowedByAdmin = adminLimitRows.some((r) => r.totalMessageLimit != null && Number(r.totalMessageLimit) > 0);
                    console.log('[PAYMENT_FLOW] SMS Admin Check:', { 
                        assignedAdmins: assignedAdmins.length, 
                        smsAllowedByAdmin, 
                        admins: assignedAdmins.map(a => ({ id: a.id, limit: a.totalMessageLimit, used: a.smsUsedCount }))
                    });
                } else {
                    console.log('[PAYMENT_FLOW] SMS Admin Check: No assigned admins, allowing (super admin managed)');
                }
                // else: no assigned admins → keep true so super admin can enable SMS for this screen
            } catch (e) {
                console.log('[PAYMENT_FLOW] SMS Admin Check Error:', e.message);
            }
            console.log('[PAYMENT_FLOW] SMS Send Conditions:', {
                hasConfig: !!smsConfig,
                smsEnabled: smsConfig?.smsEnabled,
                hasUser: !!updatedBMI.user,
                hasMobile: !!(updatedBMI.user && updatedBMI.user.mobile),
                smsAllowedByAdmin,
                allConditionsMet: !!(smsConfig && smsConfig.smsEnabled && updatedBMI.user && updatedBMI.user.mobile && smsAllowedByAdmin)
            });
            if (smsConfig && smsConfig.smsEnabled && updatedBMI.user && updatedBMI.user.mobile && smsAllowedByAdmin) {
                const limit = smsConfig.smsLimitPerScreen != null ? Number(smsConfig.smsLimitPerScreen) : null;
                const sent = (smsConfig.smsSentCount != null ? Number(smsConfig.smsSentCount) : 0) || 0;
                // Check admin-level limits: find an admin that has limit > 0 and usage < limit
                let canSendAtAdminLevel = assignedAdmins.length === 0; // No assigned admins = super admin managed, allow
                if (assignedAdmins.length > 0) {
                    canSendAtAdminLevel = assignedAdmins.some((admin) => {
                        const adminLimit = admin.totalMessageLimit != null ? Number(admin.totalMessageLimit) : null;
                        const adminUsed = Number(admin.smsUsedCount) || 0;
                        return adminLimit != null && adminLimit > 0 && adminUsed < adminLimit;
                    });
                }
                if ((limit == null || sent < limit) && canSendAtAdminLevel) {
                    const smsMessage = buildPostPaymentMessage(
                        postPaymentSmsTemplate,
                        updatedBMI.weightKg,
                        updatedBMI.bmi
                    );
                    
                    // Log SMS config and details before sending
                    const smsCredentials = {
                        apiBaseUrl: process.env.OTP_API_BASE_URL || 'http://sms6.rmlconnect.net:8080',
                        username: process.env.OTP_USERNAME || '',
                        password: process.env.OTP_PASSWORD ? '***' + process.env.OTP_PASSWORD.slice(-2) : '***', // Mask password, show last 2 chars
                        source: process.env.OTP_SOURCE || '',
                        entityId: process.env.OTP_ENTITY_ID || '',
                        templateId: process.env.OTP_TEMPLATE_ID || '',
                        dltEnabled: !!(process.env.OTP_ENTITY_ID && process.env.OTP_TEMPLATE_ID),
                        hasCredentials: !!(process.env.OTP_API_BASE_URL && process.env.OTP_USERNAME && process.env.OTP_PASSWORD && process.env.OTP_SOURCE)
                    };
                    
                    console.log('[PAYMENT_FLOW] 📱 SMS SENDING - CONFIG & DETAILS:', {
                        screenId: updatedBMI.screenId,
                        userId: updatedBMI.user.id,
                        userMobile: updatedBMI.user.mobile,
                        userName: updatedBMI.user.name,
                        smsCredentials: smsCredentials,
                        smsConfig: {
                            enabled: smsConfig.smsEnabled,
                            limitPerScreen: smsConfig.smsLimitPerScreen,
                            sentCount: smsConfig.smsSentCount,
                            remaining: limit != null ? (limit - sent) : 'unlimited'
                        },
                        adminLimits: assignedAdmins.length > 0 ? assignedAdmins.map(a => ({
                            adminId: a.id,
                            totalLimit: a.totalMessageLimit,
                            used: a.smsUsedCount,
                            remaining: a.totalMessageLimit != null ? (a.totalMessageLimit - (Number(a.smsUsedCount) || 0)) : null
                        })) : 'No assigned admins (super admin managed)',
                        message: {
                            content: smsMessage,
                            length: smsMessage.length,
                            template: postPaymentSmsTemplate
                        },
                        limitsCheck: {
                            screenLevel: {
                                limit: limit,
                                sent: sent,
                                canSend: limit == null || sent < limit
                            },
                            adminLevel: {
                                canSend: canSendAtAdminLevel,
                                assignedAdminsCount: assignedAdmins.length
                            }
                        }
                    });
                    
                    const sr = await sendBulkSms({
                        destination: updatedBMI.user.mobile,
                        message: smsMessage,
                        type: 0,
                        dlr: 0
                    });
                    
                    if (sr.success) {
                        console.log('[PAYMENT_FLOW] ✅ Post-payment SMS sent successfully:', {
                            destination: updatedBMI.user.mobile,
                            messageId: sr.messageId || 'N/A',
                            response: sr
                        });
                        
                        // Increment screen-level count
                        await prisma.$executeRawUnsafe(
                            `ALTER TABLE "AdscapePlayer" ADD COLUMN IF NOT EXISTS "smsSentCount" INTEGER DEFAULT 0`
                        );
                        await prisma.$executeRawUnsafe(
                            `UPDATE "AdscapePlayer" SET "smsSentCount" = COALESCE("smsSentCount", 0) + 1 WHERE "screenId" = $1`,
                            updatedBMI.screenId
                        );
                        
                        // Get updated screen count
                        const updatedScreenCount = await prisma.$queryRawUnsafe(
                            `SELECT COALESCE("smsSentCount", 0) as "smsSentCount" FROM "AdscapePlayer" WHERE "screenId" = $1 LIMIT 1`,
                            updatedBMI.screenId
                        );
                        const newScreenSentCount = updatedScreenCount && updatedScreenCount[0] ? Number(updatedScreenCount[0].smsSentCount) : sent + 1;
                        
                        // Increment admin-level usage for all assigned admins (if any)
                        const updatedAdminCounts = [];
                        if (assignedAdmins.length > 0) {
                            try {
                                await prisma.$executeRawUnsafe(
                                    `ALTER TABLE "AdminUser" ADD COLUMN IF NOT EXISTS "smsUsedCount" INTEGER DEFAULT 0`
                                );
                                for (const admin of assignedAdmins) {
                                    const adminLimit = admin.totalMessageLimit != null ? Number(admin.totalMessageLimit) : null;
                                    if (adminLimit != null && adminLimit > 0) {
                                        await prisma.$executeRawUnsafe(
                                            `UPDATE "AdminUser" SET "smsUsedCount" = COALESCE("smsUsedCount", 0) + 1 WHERE id = CAST($1 AS uuid)`,
                                            admin.id
                                        );
                                        // Get updated admin count
                                        const updatedAdminCount = await prisma.$queryRawUnsafe(
                                            `SELECT COALESCE("smsUsedCount", 0) as "smsUsedCount" FROM "AdminUser" WHERE id = CAST($1 AS uuid) LIMIT 1`,
                                            admin.id
                                        );
                                        const newAdminUsedCount = updatedAdminCount && updatedAdminCount[0] ? Number(updatedAdminCount[0].smsUsedCount) : (Number(admin.smsUsedCount) || 0) + 1;
                                        updatedAdminCounts.push({
                                            adminId: admin.id,
                                            previousUsed: Number(admin.smsUsedCount) || 0,
                                            newUsed: newAdminUsedCount,
                                            totalLimit: adminLimit,
                                            remaining: adminLimit - newAdminUsedCount
                                        });
                                    }
                                }
                            } catch (_) {}
                        }
                        
                        console.log('[PAYMENT_FLOW] 📊 SMS COUNTS UPDATED:', {
                            screenId: updatedBMI.screenId,
                            screenLevel: {
                                previousSent: sent,
                                newSent: newScreenSentCount,
                                limit: limit,
                                remaining: limit != null ? (limit - newScreenSentCount) : 'unlimited'
                            },
                            adminLevel: updatedAdminCounts.length > 0 ? updatedAdminCounts : 'No admin limits to update'
                        });
                    } else {
                        console.warn('[PAYMENT_FLOW] ❌ Post-payment SMS failed:', {
                            destination: updatedBMI.user.mobile,
                            error: sr.error,
                            errorCode: sr.errorCode,
                            response: sr,
                            config: {
                                screenId: updatedBMI.screenId,
                                screenLimit: limit,
                                screenSent: sent,
                                adminLimits: assignedAdmins.map(a => ({
                                    adminId: a.id,
                                    limit: a.totalMessageLimit,
                                    used: a.smsUsedCount
                                }))
                            }
                        });
                    }
                } else {
                    if (!canSendAtAdminLevel) {
                        console.log('[PAYMENT_FLOW] SMS skipped: admin limit reached', { admins: assignedAdmins.map(a => ({ id: a.id, limit: a.totalMessageLimit, used: a.smsUsedCount })) });
                    } else {
                        console.log('[PAYMENT_FLOW] SMS skipped: screen limit reached', { sent, limit });
                    }
                }
            } else {
                if (!smsConfig) {
                    console.log('[PAYMENT_FLOW] SMS skipped: no SMS config found');
                } else if (!smsConfig.smsEnabled) {
                    console.log('[PAYMENT_FLOW] SMS skipped: SMS not enabled for screen');
                } else if (!updatedBMI.user || !updatedBMI.user.mobile) {
                    console.log('[PAYMENT_FLOW] SMS skipped: no user mobile');
                } else if (!smsAllowedByAdmin) {
                    console.log('[PAYMENT_FLOW] SMS skipped: not allowed by admin (no admin with totalMessageLimit > 0)');
                }
            }
        } catch (smsErr) {
            if ((smsErr.code === '42703' || (smsErr.message && smsErr.message.includes('does not exist')))) {
                console.log('[PAYMENT_FLOW] SMS columns not present on AdscapePlayer, skipping post-payment SMS');
            } else {
                console.warn('[PAYMENT_FLOW] Post-payment SMS error (non-fatal):', smsErr.message);
            }
        }
        
        // Send WhatsApp if enabled and within limit
        try {
            await prisma.$executeRawUnsafe(
                `ALTER TABLE "AdscapePlayer" ADD COLUMN IF NOT EXISTS "whatsappEnabled" BOOLEAN DEFAULT false`
            );
            await prisma.$executeRawUnsafe(
                `ALTER TABLE "AdscapePlayer" ADD COLUMN IF NOT EXISTS "whatsappLimitPerScreen" INTEGER`
            );
            await prisma.$executeRawUnsafe(
                `ALTER TABLE "AdscapePlayer" ADD COLUMN IF NOT EXISTS "whatsappSentCount" INTEGER DEFAULT 0`
            );
            const waConfigRows = await prisma.$queryRawUnsafe(
                `SELECT "whatsappEnabled", "whatsappLimitPerScreen", "whatsappSentCount" FROM "AdscapePlayer" WHERE "screenId" = $1 LIMIT 1`,
                updatedBMI.screenId
            );
            const waConfig = waConfigRows && waConfigRows[0] ? waConfigRows[0] : null;
            console.log('[PAYMENT_FLOW] WhatsApp Config:', { 
                exists: !!waConfig, 
                whatsappEnabled: waConfig?.whatsappEnabled, 
                limit: waConfig?.whatsappLimitPerScreen, 
                sent: waConfig?.whatsappSentCount,
                screenId: updatedBMI.screenId 
            });
            // WhatsApp: enabled when (1) screen is not assigned to any admin — super admin can enable for those screens,
            // or (2) at least one assigned admin has totalWhatsAppLimit > 0 (super admin has set a limit for that admin).
            let whatsappAllowedByAdmin = true;
            let assignedAdminsWa = [];
            try {
                const adminWaRows = await prisma.$queryRawUnsafe(
                    `SELECT au.id, au."totalWhatsAppLimit", COALESCE(au."whatsappUsedCount", 0) as "whatsappUsedCount" FROM "AdminScreenAssignment" asa JOIN "AdminUser" au ON au.id = asa."adminId" WHERE asa."screenId" = $1`,
                    updatedBMI.screenId
                );
                if (Array.isArray(adminWaRows) && adminWaRows.length > 0) {
                    assignedAdminsWa = adminWaRows;
                    whatsappAllowedByAdmin = adminWaRows.some((r) => r.totalWhatsAppLimit != null && Number(r.totalWhatsAppLimit) > 0);
                    console.log('[PAYMENT_FLOW] WhatsApp Admin Check:', { 
                        assignedAdmins: assignedAdminsWa.length, 
                        whatsappAllowedByAdmin, 
                        admins: assignedAdminsWa.map(a => ({ id: a.id, limit: a.totalWhatsAppLimit, used: a.whatsappUsedCount }))
                    });
                } else {
                    console.log('[PAYMENT_FLOW] WhatsApp Admin Check: No assigned admins, allowing (super admin managed)');
                }
                // else: no assigned admins → keep true so super admin can enable WhatsApp for this screen
            } catch (e) {
                console.log('[PAYMENT_FLOW] WhatsApp Admin Check Error:', e.message);
            }
            console.log('[PAYMENT_FLOW] WhatsApp Send Conditions:', {
                hasConfig: !!waConfig,
                whatsappEnabled: waConfig?.whatsappEnabled,
                hasUser: !!updatedBMI.user,
                hasMobile: !!(updatedBMI.user && updatedBMI.user.mobile),
                whatsappAllowedByAdmin,
                allConditionsMet: !!(waConfig && waConfig.whatsappEnabled && updatedBMI.user && updatedBMI.user.mobile && whatsappAllowedByAdmin)
            });
            if (waConfig && waConfig.whatsappEnabled && updatedBMI.user && updatedBMI.user.mobile && whatsappAllowedByAdmin) {
                const waLimit = waConfig.whatsappLimitPerScreen != null ? Number(waConfig.whatsappLimitPerScreen) : null;
                const waSent = (waConfig.whatsappSentCount != null ? Number(waConfig.whatsappSentCount) : 0) || 0;
                // Check admin-level limits: find an admin that has limit > 0 and usage < limit
                let canSendAtAdminLevel = assignedAdminsWa.length === 0; // No assigned admins = super admin managed, allow
                if (assignedAdminsWa.length > 0) {
                    canSendAtAdminLevel = assignedAdminsWa.some((admin) => {
                        const adminLimit = admin.totalWhatsAppLimit != null ? Number(admin.totalWhatsAppLimit) : null;
                        const adminUsed = Number(admin.whatsappUsedCount) || 0;
                        return adminLimit != null && adminLimit > 0 && adminUsed < adminLimit;
                    });
                }
                if ((waLimit == null || waSent < waLimit) && canSendAtAdminLevel) {
                    const waResult = await sendWellTemplate({
                        receiver: updatedBMI.user.mobile,
                        name: updatedBMI.user.name || 'User',
                        weightKg: updatedBMI.weightKg != null ? updatedBMI.weightKg : '',
                        heightCm: updatedBMI.heightCm != null ? updatedBMI.heightCm : '',
                        bmi: updatedBMI.bmi != null ? updatedBMI.bmi : '',
                        fortune: (updatedBMI.fortune != null && String(updatedBMI.fortune).trim()) ? String(updatedBMI.fortune).trim() : '',
                        healthTip: (updatedBMI.healthTip != null && String(updatedBMI.healthTip).trim()) ? String(updatedBMI.healthTip).trim() : ''
                    });
                    if (waResult.success) {
                        console.log('[PAYMENT_FLOW] ✅ Post-payment WhatsApp (well) sent to', updatedBMI.user.mobile);
                        // Increment screen-level count
                        await prisma.$executeRawUnsafe(
                            `ALTER TABLE "AdscapePlayer" ADD COLUMN IF NOT EXISTS "whatsappSentCount" INTEGER DEFAULT 0`
                        );
                        await prisma.$executeRawUnsafe(
                            `UPDATE "AdscapePlayer" SET "whatsappSentCount" = COALESCE("whatsappSentCount", 0) + 1 WHERE "screenId" = $1`,
                            updatedBMI.screenId
                        );
                        // Increment admin-level usage for all assigned admins (if any)
                        if (assignedAdminsWa.length > 0) {
                            try {
                                await prisma.$executeRawUnsafe(
                                    `ALTER TABLE "AdminUser" ADD COLUMN IF NOT EXISTS "whatsappUsedCount" INTEGER DEFAULT 0`
                                );
                                for (const admin of assignedAdminsWa) {
                                    const adminLimit = admin.totalWhatsAppLimit != null ? Number(admin.totalWhatsAppLimit) : null;
                                    if (adminLimit != null && adminLimit > 0) {
                                        await prisma.$executeRawUnsafe(
                                            `UPDATE "AdminUser" SET "whatsappUsedCount" = COALESCE("whatsappUsedCount", 0) + 1 WHERE id = CAST($1 AS uuid)`,
                                            admin.id
                                        );
                                    }
                                }
                            } catch (_) {}
                        }
                    } else {
                        console.warn('[PAYMENT_FLOW] Post-payment WhatsApp failed:', waResult.error, waResult.errorCode);
                    }
                } else {
                    if (!canSendAtAdminLevel) {
                        console.log('[PAYMENT_FLOW] WhatsApp skipped: admin limit reached', { admins: assignedAdminsWa.map(a => ({ id: a.id, limit: a.totalWhatsAppLimit, used: a.whatsappUsedCount })) });
                    } else {
                        console.log('[PAYMENT_FLOW] WhatsApp skipped: screen limit reached', { sent: waSent, limit: waLimit });
                    }
                }
            } else {
                if (!waConfig) {
                    console.log('[PAYMENT_FLOW] WhatsApp skipped: no WhatsApp config found');
                } else if (!waConfig.whatsappEnabled) {
                    console.log('[PAYMENT_FLOW] WhatsApp skipped: WhatsApp not enabled for screen');
                } else if (!updatedBMI.user || !updatedBMI.user.mobile) {
                    console.log('[PAYMENT_FLOW] WhatsApp skipped: no user mobile');
                } else if (!whatsappAllowedByAdmin) {
                    console.log('[PAYMENT_FLOW] WhatsApp skipped: not allowed by admin (no admin with totalWhatsAppLimit > 0)');
                }
            }
        } catch (waErr) {
            if ((waErr.code === '42703' || (waErr.message && waErr.message.includes('does not exist')))) {
                console.log('[PAYMENT_FLOW] WhatsApp columns not present on AdscapePlayer, skipping post-payment WhatsApp');
            } else {
                console.warn('[PAYMENT_FLOW] Post-payment WhatsApp error (non-fatal):', waErr.message);
            }
        }
        
       // Emit payment success to Android screen (for F1/F3 flows - non-F2 versions)
        // Always emit for non-F2 flows to ensure Android receives payment confirmation
        if (normalizedAppVersion !== 'f2' && io) {
            const paymentSuccessPayload = {
                bmiId: updatedBMI.id,
                screenId: updatedBMI.screenId,
                userId: updatedBMI.userId,
                user: updatedBMI.user,
                bmi: updatedBMI.bmi,
                category: updatedBMI.category,
                height: updatedBMI.heightCm,
                weight: updatedBMI.weightKg,
                timestamp: updatedBMI.timestamp.toISOString(),
                paymentToken: paymentToken || null // Include payment token for Android verification
            };
            
            // ========== PAYMENT FLOW LOGGING - EMITTING TO ANDROID ==========
            console.log('═══════════════════════════════════════════════════════════════');
            console.log('[PAYMENT_FLOW] 📡 EMITTING PAYMENT SUCCESS TO ANDROID');
            console.log('[PAYMENT_FLOW] Target Screen:', updatedBMI.screenId);
            console.log('[PAYMENT_FLOW] Socket Room: screen:' + updatedBMI.screenId);
            console.log('[PAYMENT_FLOW] Payload:', JSON.stringify(paymentSuccessPayload, null, 2));
            console.log('═══════════════════════════════════════════════════════════════');
            
            const roomName = `screen:${updatedBMI.screenId}`;
            const room = io.sockets.adapter.rooms.get(roomName);
            const roomSize = room ? room.size : 0;
            
            console.log('[PAYMENT_FLOW] 📡 About to emit to room:', roomName);
            console.log('[PAYMENT_FLOW] Room members count:', roomSize);
            console.log('[PAYMENT_FLOW] Room exists:', room !== undefined);
            
            if (roomSize === 0) {
                console.log('[PAYMENT_FLOW] ⚠️⚠️⚠️ WARNING: Room is empty! No Android clients connected to room:', roomName);
                console.log('[PAYMENT_FLOW] ⚠️ This means the Android app may not have joined the room yet');
            }
            
            io.to(roomName).emit('payment-success', paymentSuccessPayload);
            console.log('[PAYMENT] ✅ Payment success event emitted to room:', roomName);
            console.log('[PAYMENT] ✅ Target screen:', updatedBMI.screenId, 'appVersion:', appVersion);
            console.log('[PAYMENT] ✅ Room members:', roomSize);
            console.log('[PAYMENT] Payload:', JSON.stringify(paymentSuccessPayload, null, 2));
        } else {
            console.log('[PAYMENT] F2 version detected - skipping socket emission to Android. appVersion:', appVersion);
        }
        
        console.log('[PAYMENT_FLOW] ✅ Payment flow completed successfully on server');
        
        return res.json({ ok: true, message: 'Payment processed successfully' });
    } catch (e) {
        console.log('[PAYMENT_FLOW] ❌ Error processing payment success:', e.message);
        console.error('[PAYMENT] POST /api/payment-success error', e);
        return res.status(500).json({ error: 'internal_error' });
    }
};

/**
 * POST /api/progress-start -> { bmiId } -> emit progress start to both web and Android
 */
exports.progressStart = async (req, res, io) => {
    try {
        const { bmiId } = req.body || {};
        if (!bmiId) {
            return res.status(400).json({ error: 'bmiId required' });
        }
        
        // Get BMI data
        const bmiData = await prisma.bMI.findUnique({
            where: { id: bmiId },
            include: { user: true, screen: true }
        });
        
        if (!bmiData) {
            return res.status(404).json({ error: 'BMI data not found' });
        }
        
        // Emit progress start to Android screen
        if (io) {
            io.to(`screen:${bmiData.screenId}`).emit('progress-start', {
                bmiId: bmiData.id,
                screenId: bmiData.screenId,
                userId: bmiData.userId,
                user: bmiData.user,
                bmi: bmiData.bmi,
                category: bmiData.category,
                height: bmiData.heightCm,
                weight: bmiData.weightKg,
                timestamp: bmiData.timestamp.toISOString(),
                progressComplete: true // Flag to indicate this is progress start data
            });
        }
        
        console.log('[PROGRESS] Start emitted to screen:', bmiData.screenId);
        
        return res.json({ ok: true, message: 'Progress started' });
    } catch (e) {
        console.error('[PROGRESS] POST /api/progress-start error', e);
        return res.status(500).json({ error: 'internal_error' });
    }
};

/**
 * POST /api/fortune-generate -> { bmiId } -> generate fortune and emit to both web and Android
 */
exports.fortuneGenerate = async (req, res, io) => {
    try {
        console.log('[FORTUNE] Request body:', req.body);
        console.log('[FORTUNE] Request body type:', typeof req.body);
        
        const { bmiId, appVersion } = req.body || {};
        console.log('[FORTUNE] Extracted bmiId:', bmiId, 'appVersion:', appVersion);
        
        if (!bmiId) {
            console.log('[FORTUNE] Missing bmiId in request');
            return res.status(400).json({ error: 'bmiId required' });
        }
        
        // Get BMI data
        const bmiData = await prisma.bMI.findUnique({
            where: { id: bmiId },
            include: { user: true, screen: true }
        });
        
        if (!bmiData) {
            return res.status(404).json({ error: 'BMI data not found' });
        }
        
        // Use existing fortune if available, otherwise generate new one
        let fortuneMessage = bmiData.fortune;
        if (!fortuneMessage) {
            console.log('[FORTUNE] No existing fortune, generating new one');
            fortuneMessage = await generateFortuneMessage({
                bmi: bmiData.bmi,
                category: bmiData.category
            });
            
            // Update BMI record with generated fortune
            await prisma.bMI.update({
                where: { id: bmiId },
                data: { fortune: fortuneMessage }
            });
        } else {
            console.log('[FORTUNE] Using existing fortune from database');
        }
        
        const fortuneData = {
            bmiId: bmiData.id,
            screenId: bmiData.screenId,
            userId: bmiData.userId,
            user: bmiData.user,
            bmi: bmiData.bmi,
            category: bmiData.category,
            height: bmiData.heightCm,
            weight: bmiData.weightKg,
            timestamp: bmiData.timestamp.toISOString(),
            fortuneMessage: fortuneMessage
        };
        
        // Emit fortune to Android screen (only for non-F2 versions)
        if (appVersion !== 'f2' && io) {
            io.to(`screen:${bmiData.screenId}`).emit('fortune-ready', fortuneData);
            console.log('[FORTUNE] Generated and emitted to screen:', bmiData.screenId);
        } else {
            console.log('[FORTUNE] F2 version - skipping socket emission to Android');
        }
        
        console.log('[FORTUNE] Message:', fortuneMessage);
        
        return res.json({ ok: true, fortuneMessage, data: fortuneData });
    } catch (e) {
        console.error('[FORTUNE] POST /api/fortune-generate error', e);
        return res.status(500).json({ error: 'internal_error' });
    }
};

/**
 * GET /api/user/:userId/analytics -> return user analytics data
 */
exports.getUserAnalytics = async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Get all BMI records for user
        const bmiRecords = await prisma.bMI.findMany({
            where: { userId: userId },
            orderBy: { timestamp: 'desc' },
            include: {
                screen: true
            }
        });
        
        if (bmiRecords.length === 0) {
            return res.json({
                totalRecords: 0,
                recentBMI: null,
                streak: { currentStreak: 0, longestStreak: 0, isActive: false },
                trends: [],
                categoryDistribution: {},
                averageBMI: 0
            });
        }
        
        // Calculate streak
        const streak = calculateStreak(bmiRecords);

        // Get unique screen IDs for all records and fetch their device names
        const allScreenIds = [...new Set(bmiRecords.map(record => record.screenId))];
        const screenPlayers = await prisma.adscapePlayer.findMany({
            where: {
                screenId: { in: allScreenIds }
            },
            select: {
                screenId: true,
                deviceName: true
            }
        });
        
        // Create a map of screenId to deviceName
        const screenNameMap = {};
        screenPlayers.forEach(player => {
            screenNameMap[player.screenId] = player.deviceName || player.screenId;
        });

        // Get recent BMI (most recent record)
        const recentBMI = {
            id: bmiRecords[0].id,
            bmi: bmiRecords[0].bmi,
            category: bmiRecords[0].category,
            height: bmiRecords[0].heightCm,
            weight: bmiRecords[0].weightKg,
            timestamp: bmiRecords[0].timestamp.toISOString(),
            screenId: bmiRecords[0].screenId,
            screenName: screenNameMap[bmiRecords[0].screenId] || bmiRecords[0].screenId,
            deviceId: bmiRecords[0].deviceId,
            location: bmiRecords[0].location,
            fortune: bmiRecords[0].fortune
        };
        
        // Calculate trends (last 30 days)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        
        const recentRecords = bmiRecords.filter(record => 
            new Date(record.timestamp) >= thirtyDaysAgo
        );
        
        const trends = recentRecords.map(record => ({
            date: record.timestamp.toISOString().split('T')[0],
            bmi: record.bmi,
            weight: record.weightKg,
            category: record.category,
            screenId: record.screenId,
            screenName: screenNameMap[record.screenId] || record.screenId,
            timestamp: record.timestamp.toISOString()
        })).reverse(); // Oldest first for chart
        
        // Category distribution
        const categoryDistribution = {};
        bmiRecords.forEach(record => {
            categoryDistribution[record.category] = (categoryDistribution[record.category] || 0) + 1;
        });
        
        // Average BMI
        const averageBMI = Number((bmiRecords.reduce((sum, record) => sum + record.bmi, 0) / bmiRecords.length).toFixed(1));
        
        return res.json({
            totalRecords: bmiRecords.length,
            recentBMI,
            streak,
            trends,
            categoryDistribution,
            averageBMI,
            firstRecord: bmiRecords[bmiRecords.length - 1].timestamp.toISOString(),
            lastRecord: bmiRecords[0].timestamp.toISOString()
        });
    } catch (e) {
        console.error('[ANALYTICS] GET /api/user/:userId/analytics error', e);
        return res.status(500).json({ error: 'internal_error' });
    }
};

/**
 * POST /api/bmi/:id/link-user -> link BMI record to user
 */
exports.linkUserToBMI = async (req, res) => {
    try {
        const { id } = req.params;
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'userId required' });
        }
        
        console.log(`[BMI-LINK] Linking BMI ${id} to user ${userId}`);
        
        // Update BMI record with user ID
        const updatedBMI = await prisma.bMI.update({
            where: { id },
            data: { userId },
            include: {
                user: true,
                screen: true
            }
        });
        
        console.log(`[BMI-LINK] Successfully linked BMI to user: ${updatedBMI.user?.name}`);
        
        return res.json({ 
            ok: true, 
            message: 'BMI record linked to user successfully',
            bmi: {
                bmiId: updatedBMI.id,
                screenId: updatedBMI.screenId,
                height: updatedBMI.heightCm,
                weight: updatedBMI.weightKg,
                bmi: updatedBMI.bmi,
                category: updatedBMI.category,
                timestamp: updatedBMI.timestamp.toISOString(),
                userId: updatedBMI.userId,
                user: updatedBMI.user ? {
                    id: updatedBMI.user.id,
                    name: updatedBMI.user.name,
                    mobile: updatedBMI.user.mobile
                } : null
            }
        });
    } catch (e) {
        console.error('[BMI-LINK] Error linking BMI to user:', e);
        return res.status(500).json({ error: 'internal_error' });
    }
};

/**
 * GET /api/bmi/:id -> return stored payload
 */
exports.getBMI = async (req, res) => {
    const id = req.params.id;
    console.log(`[BMI] GET request for id: ${id}`);
    
    try {
        const webLinkExpired = await getWebLinkExpiredFlag(id);
        if (webLinkExpired) {
            console.log(`[BMI] Link already expired for id: ${id}`);
            return res.status(410).json({
                error: 'link_expired',
                message: 'This BMI result link has already been used.',
                redirectTo: '/dashboard',
                bmiId: id
            });
        }

        // Try in-memory store first
        const mem = bmiStore.get(id);
        if (mem) {
            console.log(`[BMI] Found in memory:`, mem);
            return res.json(mem);
        }
        
        console.log(`[BMI] Searching database for id: ${id}`);
        const row = await prisma.bMI.findUnique({ 
            where: { id },
            include: {
                user: true,
                screen: true
            }
        });
        
        if (!row) {
            console.log(`[BMI] Not found in database: ${id}`);
            return res.status(404).json({ 
                error: 'not_found', 
                message: `BMI record ${id} not found`,
                id: id
            });
        }

        const result = {
            bmiId: row.id,
            screenId: row.screenId,
            height: row.heightCm,
            weight: row.weightKg,
            bmi: row.heightCm > 0 ? row.bmi : null,
            category: row.category,
            timestamp: row.timestamp.toISOString(),
            isHeightValid: row.heightCm > 0,
            fortune: row.fortune,
            fortuneMessage: row.fortune,
            healthTip: row.healthTip ?? null,
            userId: row.userId,
            paymentStatus: row.paymentStatus ?? false,
            user: row.user ? {
                id: row.user.id,
                name: row.user.name,
                mobile: row.user.mobile
            } : null
        };
        
        console.log(`[BMI] Found in database:`, result);
        return res.json(result);
    } catch (e) {
        console.error('[BMI] GET error', e);
        return res.status(500).json({ 
            error: 'internal_error', 
            message: e.message,
            stack: e.stack
        });
    }
};

/**
 * POST /api/bmi/:id/expire-link -> expire QR/web link after flow completion
 */
exports.expireBMILink = async (req, res) => {
    const { id } = req.params;

    try {
        await ensureWebLinkExpiryColumn();
        await prisma.$executeRawUnsafe(
            `UPDATE "BMI" SET "webLinkExpired" = true WHERE id = $1::uuid`,
            id
        );

        console.log(`[BMI] Web link expired for id: ${id}`);
        return res.json({ ok: true, bmiId: id, webLinkExpired: true });
    } catch (e) {
        console.error('[BMI] Failed to expire BMI link:', e);
        return res.status(500).json({ error: 'internal_error' });
    }
};

/**
 * GET /api/debug/connections -> Debug socket connections
 */
exports.debugConnections = (req, res, io) => {
    try {
        const rooms = [];
        if (io) {
            io.sockets.adapter.rooms.forEach((socketsSet, room) => {
                rooms.push({ room, size: socketsSet.size });
            });
        }
        const sockets = [];
        if (io) {
            io.sockets.sockets.forEach((sock) => sockets.push(sock.id));
        }
        res.json({ rooms, sockets });
    } catch (e) {
        res.status(500).json({ error: 'debug_error' });
    }
};



