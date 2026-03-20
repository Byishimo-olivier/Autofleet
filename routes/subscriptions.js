const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/helpers');
const PaypackService = require('../Service/PaypackService');
const FlutterwaveService = require('../Service/FlutterwaveService');


const paypackService = new PaypackService();
const flutterwaveService = new FlutterwaveService();

const SUBSCRIPTION_PLANS = [
  { id: 'basic', name: 'Basic Plan', amount: 50000, description: 'Up to 5 vehicles' },
  { id: 'premium', name: 'Premium Plan', amount: 100000, description: 'Unlimited vehicles' },
];

// Get available subscription plans
router.get('/plans', (req, res) => {
  successResponse(res, SUBSCRIPTION_PLANS, 'Subscription plans retrieved successfully');
});

// Create a subscription and initiate payment
router.post('/subscribe', authenticateToken, async (req, res) => {
  const { planId, phoneNumber, paymentMethod } = req.body;
  const userId = req.user.id;

  try {
    const plan = SUBSCRIPTION_PLANS.find(p => p.id === planId);
    if (!plan) {
      return errorResponse(res, 'Invalid subscription plan', 400);
    }

    // Check if user already has an active subscription
    const existingSub = await pool.query(
      "SELECT * FROM subscriptions WHERE user_id = $1 AND status = 'active' AND end_date > NOW()",
      [userId]
    );

    if (existingSub.rows.length > 0) {
      return errorResponse(res, 'You already have an active subscription', 400);
    }

    // Create a pending subscription record
    const subResult = await pool.query(
      `INSERT INTO subscriptions (user_id, plan_name, amount, status)
       VALUES ($1, $2, $3, 'pending') RETURNING id`,
      [userId, plan.name, plan.amount]
    );

    const subscriptionId = subResult.rows[0].id;

    if (paymentMethod === 'card') {
      // Initiate Flutterwave Card Payment
      const tx_ref = `SUB_${subscriptionId}_${Date.now()}`;
      const flwResponse = await flutterwaveService.initiatePayment({
        amount: plan.amount,
        currency: 'RWF',
        email: req.user.email,
        tx_ref,
        name: `${req.user.first_name} ${req.user.last_name}`,
        phone_number: phoneNumber || req.user.phone,
        redirect_url: `${process.env.CLIENT_URL}/dashboard?payment_status=verifying&tx_ref=${tx_ref}`
      });

      if (flwResponse.status === 'success') {
        await pool.query(
          'UPDATE subscriptions SET payment_transaction_id = $1 WHERE id = $2',
          [tx_ref, subscriptionId]
        );
        
        return successResponse(res, {
          subscriptionId,
          paymentLink: flwResponse.data.link,
          message: 'Redirecting to payment page...'
        }, 'Card payment initiated');
      } else {
        throw new Error('Flutterwave initiation failed');
      }
    } else {
      // Initiate Paypack Mobile Money Payment
      const paymentResponse = await paypackService.requestPayment(plan.amount, phoneNumber);
      const reference = paymentResponse?.ref || paymentResponse?.data?.ref;

      if (reference) {
        await pool.query(
          'UPDATE subscriptions SET payment_transaction_id = $1 WHERE id = $2',
          [reference, subscriptionId]
        );
      }

      return successResponse(res, {
        subscriptionId,
        reference,
        message: 'Subscription payment initiated. Please check your phone to confirm.'
      }, 'Subscription initiated successfully');
    }

  } catch (error) {
    console.error('Subscription error:', error);
    errorResponse(res, error.message || 'Failed to initiate subscription', 500);
  }
});

// Verify Flutterwave Payment
router.get('/verify-flw', authenticateToken, async (req, res) => {
  const { transaction_id, tx_ref } = req.query;

  try {
    if (!transaction_id) {
      return errorResponse(res, 'Missing transaction_id', 400);
    }

    const verificationData = await flutterwaveService.verifyTransaction(transaction_id);

    if (verificationData.status === 'success' && verificationData.data.status === 'successful') {
      // Extract subscription ID from tx_ref (SUB_ID_TIME)
      const subId = tx_ref ? tx_ref.split('_')[1] : null;

      // If tx_ref is missing, we try to find the subscription by transaction_id or other fields
      // But SUB_ID_TIME is safer.
      
      const startDate = new Date();
      const endDate = new Date();
      endDate.setMonth(endDate.getMonth() + 1);

      if (subId) {
        await pool.query(
          `UPDATE subscriptions
           SET status = 'active', 
               start_date = $1, 
               end_date = $2,
               payment_transaction_id = $3,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $4`,
          [startDate, endDate, transaction_id, subId]
        );
      }

      return successResponse(res, null, 'Subscription activated successfully');
    } else {
      return errorResponse(res, 'Payment verification failed', 400);
    }
  } catch (err) {
    console.error('FLW Verify Error:', err);
    return errorResponse(res, 'Verification error', 500);
  }
});

// Get current user's subscription status
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.* FROM subscriptions s
       WHERE s.user_id = $1
       ORDER BY s.created_at DESC LIMIT 1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return successResponse(res, { status: 'none' }, 'No subscription found');
    }

    const sub = result.rows[0];
    const now = new Date();
    const isActive = sub.status === 'active' && new Date(sub.end_date) > now;

    successResponse(res, {
      ...sub,
      is_active: isActive
    }, 'Subscription status retrieved');
  } catch (err) {
    console.error('Error fetching subscription status:', err);
    errorResponse(res, 'Database error', 500);
  }
});

// Admin: Get all subscriptions
router.get('/admin/all', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, u.first_name, u.last_name, u.email, u.phone
       FROM subscriptions s
       JOIN users u ON s.user_id = u.id
       ORDER BY s.created_at DESC`
    );
    successResponse(res, result.rows, 'All subscriptions retrieved');
  } catch (err) {
    console.error('Error fetching all subscriptions:', err);
    errorResponse(res, 'Database error', 500);
  }
});

// Owner: Get my subscription details
router.get('/my-subscription', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.* FROM subscriptions s WHERE s.user_id = $1 ORDER BY s.created_at DESC`,
      [req.user.id]
    );
    successResponse(res, result.rows, 'My subscriptions retrieved');
  } catch (err) {
    console.error('Error fetching my subscriptions:', err);
    errorResponse(res, 'Database error', 500);
  }
});

module.exports = router;
