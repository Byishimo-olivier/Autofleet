const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'AutoFleet Hub API is running' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AutoFleet Hub API server running on port ${PORT}`);
});

module.exports = app;

