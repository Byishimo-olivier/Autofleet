const dotenv = require('dotenv');

const paypackConfig = {
  apiKey: process.env.PAYPACK_API_KEY,
  apiSecret: process.env.PAYPACK_API_SECRET,
  baseUrl: process.env.PAYPACK_API_BASE_URL,
  currency: process.env.PAYPACK_CURRENCY,
};

module.exports = paypackConfig;