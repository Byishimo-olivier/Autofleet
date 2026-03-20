const axios = require('axios');

class FlutterwaveService {
  constructor() {
    this.secretKey = process.env.FLW_SECRET_KEY;
    this.publicKey = process.env.FLW_PUBLIC_KEY;
    this.baseUrl = 'https://api.flutterwave.com/v3';
  }

  async initiatePayment({ amount, currency, email, tx_ref, name, phone_number, redirect_url }) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/payments`,
        {
          tx_ref,
          amount,
          currency: currency || 'RWF',
          redirect_url,
          customer: {
            email,
            phonenumber: phone_number,
            name,
          },
          customizations: {
            title: 'AutoFleet Hub Subscription',
            description: 'Subscription for AutoFleet Hub',
            logo: 'https://st2.depositphotos.com/3904951/8925/v/450/depositphotos_89250312-stock-illustration-car-service-logo.jpg',
          },
        },
        {
          headers: {
            Authorization: `Bearer ${this.secretKey}`,
          },
        }
      );

      return response.data;
    } catch (error) {
      console.error('Flutterwave payment initiation failed:', error.response?.data || error.message);
      throw error;
    }
  }

  async verifyTransaction(transactionId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/transactions/${transactionId}/verify`,
        {
          headers: {
            Authorization: `Bearer ${this.secretKey}`,
          },
        }
      );
      return response.data;
    } catch (error) {
      console.error('Flutterwave verification failed:', error.response?.data || error.message);
      throw error;
    }
  }
}

module.exports = FlutterwaveService;
