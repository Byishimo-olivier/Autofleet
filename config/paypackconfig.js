const dotenv = require('dotenv');
dotenv.config();

const paypackConfig = {
  apiKey: process.env.PAYPACK_API_KEY,
  apiSecret: process.env.PAYPACK_API_SECRET,
  baseUrl: process.env.PAYPACK_API_BASE_URL || 'https://payments.paypack.rw/api',
  currency: process.env.PAYPACK_CURRENCY || 'RWF',
};

if (!paypackConfig.apiKey || !paypackConfig.apiSecret) {
  console.error('❌ Missing Paypack credentials in .env: PAYPACK_API_KEY and PAYPACK_API_SECRET are required');
} else {
  console.log('✅ Paypack Config loaded:', {
    apiKey: paypackConfig.apiKey,
    baseUrl: paypackConfig.baseUrl,
    currency: paypackConfig.currency,
  });
}

module.exports = paypackConfig;