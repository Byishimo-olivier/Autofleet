const axios = require('axios');
const pool = require('../config/database');
const paypackConfig = require('../config/paypackconfig');

class PaypackService {
  constructor(config = {}) {
    this.paypackConfig = {
      key: config.key || paypackConfig.apiKey,
      secret: config.secret || paypackConfig.apiSecret,
      // baseUrl already includes /api → https://payments.paypack.rw/api
      baseUrl: config.url || paypackConfig.baseUrl || 'https://payments.paypack.rw/api',
      currency: config.currency || paypackConfig.currency || 'RWF',
      testMode: process.env.PAYPACK_TEST_MODE === 'true'
    };

    if (!this.paypackConfig.key || !this.paypackConfig.secret) {
      throw new Error(
        'PayPack configuration missing: PAYPACK_API_KEY and PAYPACK_API_SECRET are required'
      );
    }

    console.log('🔧 PaypackService initialized with baseUrl:', this.paypackConfig.baseUrl);
  }

  /**
   * Authenticate with Paypack and get JWT access token
   * Endpoint: POST /api/auth/agents/authorize
   */
  async login() {
    try {
      console.log('🔐 Authenticating with Paypack...');

      const url = `${this.paypackConfig.baseUrl}/auth/agents/authorize`;
      console.log('   → POST', url);

      const response = await axios.post(
        url,
        {
          client_id: this.paypackConfig.key,
          client_secret: this.paypackConfig.secret
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        }
      );

      // Paypack returns { access, refresh }
      const token =
        response.data?.access ||
        response.data?.token ||
        response.data?.access_token;

      if (!token) {
        console.error('Auth response data:', response.data);
        throw new Error('Failed to obtain PayPack token — check API credentials');
      }

      console.log('✅ Paypack authentication successful');
      return token;
    } catch (error) {
      const detail = error.response?.data || error.message;
      console.error('❌ Paypack authentication failed:', detail);
      throw new Error(`PayPack auth failed: ${JSON.stringify(detail)}`);
    }
  }

  /**
   * Request payment (cashin) from Paypack
   * Endpoint: POST /api/transactions/cashin
   * @param {number} amount
   * @param {string} number - Mobile money phone number e.g. 078xxxxxxx
   */
  async requestPayment(amount, number) {
    try {
      const token = await this.login();
      const finalAmount = this.paypackConfig.testMode ? 100 : parseFloat(amount);

      if (this.paypackConfig.testMode) {
        console.log('🚧 Paypack Test Mode: Amount overridden to 100 RWF');
      }

      const url = `${this.paypackConfig.baseUrl}/transactions/cashin`;
      console.log('📱 Initiating Paypack cashin:', { url, amount: finalAmount, number });

      const response = await axios.post(
        url,
        { amount: finalAmount, number },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        }
      );

      console.log('✅ Paypack cashin initiated:', response.data);
      return response.data;
    } catch (error) {
      const detail = error.response?.data || error.message;
      console.error('❌ Paypack cashin failed:', detail);
      throw new Error(`PayPack request payment failed: ${JSON.stringify(detail)}`);
    }
  }

  /**
   * Verify a payment transaction
   * Endpoint: GET /api/transactions/find/{ref}
   * @param {string} reference
   */
  async verifyPayment(reference) {
    try {
      const token = await this.login();

      const url = `${this.paypackConfig.baseUrl}/transactions/find/${reference}`;
      console.log('🔍 Verifying Paypack transaction:', url);

      try {
        const response = await axios.get(url, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        });

        const data = response.data || {};
        if (!data.status && this.paypackConfig.testMode && data.ref) {
          data.status = 'completed';
        }
        console.log('✅ Paypack verification successful:', data);
        return data;
      } catch (verifyError) {
        // In test mode, transactions may not be immediately queryable
        if (this.paypackConfig.testMode && verifyError.response?.status === 404) {
          console.log('⚠️  Test mode: Transaction not found, treating as pending');
          return {
            ref: reference,
            status: 'pending',
            amount: 100,
            kind: 'CASHIN'
          };
        }
        throw verifyError;
      }
    } catch (error) {
      const detail = error.response?.data || error.message;
      console.error('❌ Paypack verification failed:', detail);
      throw new Error(`PayPack verification failed: ${JSON.stringify(detail)}`);
    }
  }

  /**
   * Handle Paypack webhook callback
   * @param {object} payload - Webhook payload from Paypack
   */
  async handlePaypackWebhook(payload) {
    try {
      const { reference, status, paid_at, amount, booking_id, subscription_id } = payload;

      console.log('📨 Processing Paypack webhook:', { reference, status });

      // 1. Try to find a booking with this reference
      let bookingResult = await pool.query(
        `SELECT b.*, v.owner_id FROM bookings b
         LEFT JOIN vehicles v ON b.vehicle_id = v.id
         WHERE b.payment_transaction_id = $1`,
        [reference]
      );

      if (bookingResult.rows.length === 0 && booking_id) {
        bookingResult = await pool.query(
          `SELECT b.*, v.owner_id FROM bookings b
           LEFT JOIN vehicles v ON b.vehicle_id = v.id
           WHERE b.id = $1`,
          [booking_id]
        );
      }

      if (bookingResult.rows.length > 0) {
        const booking = bookingResult.rows[0];
        let paymentStatus = 'pending';
        let bookingStatus = 'pending';

        if (status === 'completed' || status === 'successful') {
          paymentStatus = 'paid';
          bookingStatus = 'confirmed';
        } else if (status === 'failed') {
          paymentStatus = 'failed';
          bookingStatus = 'cancelled';
        }

        await pool.query(
          `UPDATE bookings
           SET payment_status = $1,
               status = $2,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [paymentStatus, bookingStatus, booking.id]
        );

        console.log(
          `✅ Booking #${booking.id} updated: status=${bookingStatus}, payment=${paymentStatus}`
        );
        return booking;
      }

      // 2. If not a booking, try to find a subscription with this reference
      let subscriptionResult = await pool.query(
        'SELECT * FROM subscriptions WHERE payment_transaction_id = $1',
        [reference]
      );

      if (subscriptionResult.rows.length === 0 && subscription_id) {
        subscriptionResult = await pool.query(
          'SELECT * FROM subscriptions WHERE id = $1',
          [subscription_id]
        );
      }

      if (subscriptionResult.rows.length > 0) {
        const sub = subscriptionResult.rows[0];
        let subStatus = 'pending';
        let startDate = null;
        let endDate = null;

        if (status === 'completed' || status === 'successful') {
          subStatus = 'active';
          startDate = new Date();
          endDate = new Date();
          endDate.setMonth(endDate.getMonth() + 1); // Default to 1 month
        } else if (status === 'failed') {
          subStatus = 'failed';
        }

        await pool.query(
          `UPDATE subscriptions
           SET status = $1,
               start_date = $2,
               end_date = $3,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $4`,
          [subStatus, startDate, endDate, sub.id]
        );

        console.log(`✅ Subscription #${sub.id} updated: status=${subStatus}`);
        return sub;
      }

      console.warn('⚠️  No booking or subscription found for reference:', reference);
    } catch (error) {
      console.error('❌ Webhook processing failed:', error.message);
      throw error;
    }
  }

  /**
   * Create payment and link to booking
   * @param {object} options
   */
  async createPayment({ booking_id, amount, phone_number }) {
    try {
      const bookingResult = await pool.query('SELECT * FROM bookings WHERE id = $1', [booking_id]);

      if (bookingResult.rows.length === 0) {
        throw new Error(`Booking #${booking_id} not found`);
      }

      const booking = bookingResult.rows[0];

      const paymentResponse = await this.requestPayment(amount, phone_number);

      // Paypack returns { ref, amount, status, kind, created_at }
      const reference = paymentResponse?.ref || paymentResponse?.data?.ref;

      if (reference && booking.payment_transaction_id !== reference) {
        await pool.query(
          'UPDATE bookings SET payment_transaction_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [reference, booking_id]
        );
      }

      return {
        success: true,
        reference,
        booking_id,
        paypack_response: paymentResponse
      };
    } catch (error) {
      console.error('❌ Create payment failed:', error.message);
      throw error;
    }
  }
}

module.exports = PaypackService;
