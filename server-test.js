const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Initialize database
const db = require('./config/database');

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'AutoFleet Hub API is running' });
});

// Test route
app.get('/api/test', (req, res) => {
  res.json({ message: 'Test route working' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AutoFleet Hub API server running on port ${PORT}`);
});

module.exports = app;

