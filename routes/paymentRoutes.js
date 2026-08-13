const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const bmiFlowController = require('../controllers/bmiFlowController');

// Export a function that accepts io
module.exports = (io) => {
    // GET /api/payment/key -> Get Razorpay key ID
    router.get('/payment/key', paymentController.getKey);

    // POST /api/payment/create-order -> Create Razorpay order
    router.post('/payment/create-order', (req, res) => paymentController.createOrder(req, res, io));

    // POST /api/payment/verify -> Verify payment signature and notify Android
    router.post('/payment/verify', (req, res) => paymentController.verifyPayment(req, res, io, bmiFlowController));

    return router;
};



