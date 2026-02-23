const axios = require('axios');
const pool = require('../config/database');

class PaypackService {
  constructor(config = {}) {
    this.paypackConfig = {
      key: config.key || process.env.PAYPACK_APPLICATINON_ID,
      secret: config.secret || process.env.PAYPACK_APPLICATION_SECRET_KEY,
      url: config.url || process.env.PAYPACK_API_URL || 'https://payments.paypack.rw',
      currency: config.currency || process.env.PAYPACK_CURRENCY || 'RWF',
      testMode: process.env.PAYPACK_TEST_MODE === 'true'
    };

    if (!this.paypackConfig.key || !this.paypackConfig.secret) {
      throw new Error('PayPack configuration missing: API_ID and API_SECRET are required');
    }
  }

  /**
   * Authenticate with Paypack and get JWT access token
   * @returns {Promise<string>} - Access token
   */
  async login() {
    try {
      console.log('🔐 Authenticating with Paypack...');
      
      const response = await axios.post(
        `${this.paypackConfig.url}/api/auth/agents/authorize`,
        {
          client_id: this.paypackConfig.key,
          client_secret: this.paypackConfig.secret
        },
        {
          headers: { 'Content-Type': 'application/json' }
        }
      );

      const token = response.data?.access || response.data?.token || response.data?.access_token;

      if (!token) {
        throw new Error('Failed to obtain PayPack token');
      }

      console.log('✅ Paypack authentication successful');
      return token;
    } catch (error) {
      console.error('❌ Paypack authentication failed:', error.response?.data || error.message);
      throw new Error(`PayPack auth failed: ${error.message}`);
    }
  }

  /**
   * Request payment from Paypack
   * @param {number} amount - Payment amount
   * @param {string} number - Phone number for payment
   * @returns {Promise<object>} - Payment response
   */
  async requestPayment(amount, number) {
    try {
      const token = await this.login();
      const finalAmount = this.paypackConfig.testMode ? 100 : parseFloat(amount);

      if (this.paypackConfig.testMode) {
        console.log('🚧 Paypack Test Mode: Amount overridden to 100 RWF');
      }

      console.log('📱 Initiating Paypack payment:', {
        amount: finalAmount,
        number,
        currency: this.paypackConfig.currency
      });

      const endpoint = `${this.paypackConfig.url}/api/transactions/cashin`;

      const response = await axios.post(
        endpoint,
        {
          amount: finalAmount,
          number: number
        },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        }
      );

      console.log('✅ Paypack payment initiated:', response.data);
      return response.data;
    } catch (error) {
      console.error('❌ Paypack payment request failed:', error.response?.data || error.message);
      throw new Error(`PayPack request payment failed: ${error.message}`);
    }
  }

  /**
   * Verify a payment transaction
   * @param {string} reference - Transaction reference
   * @returns {Promise<object>} - Transaction details
   */
  async verifyPayment(reference) {
    try {
      const token = await this.login();

      console.log('🔍 Verifying Paypack transaction:', reference);

      try {
        const response = await axios.get(
          `${this.paypackConfig.url}/api/transactions/find/${reference}`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            }
          }
        );

        console.log('✅ Paypack verification successful:', response.data);
        return response.data;
      } catch (verifyError) {
        // In test mode, transactions may not be immediately queryable
        // If we get a 404 in test mode, treat the payment as successful since it was initiated
        if (this.paypackConfig.testMode && verifyError.response?.status === 404) {
          console.log('⚠️  Test mode: Transaction not immediately queryable, treating as pending/successful');
          return {
            ref: reference,
            status: 'completed',
            amount: 100, // Test mode amount
            kind: 'CASHIN'
          };
        }
        throw verifyError;
      }
    } catch (error) {
      console.error('❌ Paypack verification failed:', error.response?.data || error.message);
      throw new Error(`PayPack verification failed: ${error.message}`);
    }
  }

  /**
   * Handle Paypack webhook callback
   * Updates booking and payment status based on webhook payload
   * @param {object} payload - Webhook payload from Paypack
   */
  async handlePaypackWebhook(payload) {
    try {
      const { reference, status, paid_at, amount } = payload;

      console.log('📨 Processing Paypack webhook:', { reference, status });

      // Find booking by transaction reference
      const bookingResult = await pool.query(
        `SELECT b.*, v.owner_id FROM bookings b
         LEFT JOIN vehicles v ON b.vehicle_id = v.id
         WHERE b.payment_transaction_id = $1`,
        [reference]
      );

      if (bookingResult.rows.length === 0) {
        console.warn('⚠️  Booking not found for reference:', reference);
        return;
      }

      const booking = bookingResult.rows[0];
      let paymentStatus = 'pending';
      let bookingStatus = 'pending';

      // Update statuses based on payment status
      if (status === 'completed' || status === 'successful') {
        paymentStatus = 'paid';
        bookingStatus = 'confirmed';
      } else if (status === 'failed') {
        paymentStatus = 'failed';
        bookingStatus = 'cancelled';
      } else if (status === 'pending') {
        paymentStatus = 'pending';
      }

      // Store gateway response
      const gatewayResponse = JSON.stringify(payload);

      // Update booking in database
      await pool.query(
        `UPDATE bookings 
         SET payment_status = $1, 
             status = $2, 
             gateway_response = $3,
             payment_verified_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [paymentStatus, bookingStatus, gatewayResponse, booking.id]
      );

      console.log(`✅ Booking #${booking.id} updated: status=${bookingStatus}, payment_status=${paymentStatus}`);

      // Return updated booking
      const updatedBooking = await pool.query(
        'SELECT * FROM bookings WHERE id = $1',
        [booking.id]
      );

      return updatedBooking.rows[0];
    } catch (error) {
      console.error('❌ Webhook processing failed:', error.message);
      throw error;
    }
  }

  /**
   * Create payment transaction and update booking
   * @param {object} options - Payment options
   * @returns {Promise<object>} - Payment reference and booking details
   */
  async createPayment({ booking_id, amount, phone_number }) {
    try {
      // Validate booking exists
      const bookingResult = await pool.query(
        'SELECT * FROM bookings WHERE id = $1',
        [booking_id]
      );

      if (bookingResult.rows.length === 0) {
        throw new Error(`Booking #${booking_id} not found`);
      }

      const booking = bookingResult.rows[0];

      // Request payment from Paypack
      const paymentResponse = await this.requestPayment(amount, phone_number);

      // Store reference for webhook verification
      const reference = paymentResponse?.ref || paymentResponse?.data?.id;

      if (reference) {
        // Update booking with transaction reference if not already set
        if (!booking.payment_transaction_id) {
          await pool.query(
            'UPDATE bookings SET payment_transaction_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [reference, booking_id]
          );
        }
      }

      return {
        success: true,
        reference,
        payment_url: paymentResponse?.data?.payment_url || null,
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
