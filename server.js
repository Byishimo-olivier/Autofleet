const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// ----------------------
// Middleware
// ----------------------
app.use(cors());

// Serve static files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ----------------------
// Routes
// ----------------------
// CRITICAL: Load routes that handle multipart/form-data (file uploads) 
// BEFORE applying body parsers. This prevents bodyParser from consuming 
// the request body before multer can parse the multipart data.
try {

  // Load file-upload route before body parsers

  console.log("Loading /api/vehicle-images...");
  app.use('/api/vehicle-images', require('./routes/vehicles-upload'));
  console.log("Registered /api/vehicle-images");

  // Apply body parsers after file-upload route

  app.use(express.json());
  console.log("Registered express.json()");
  app.use(bodyParser.json());
  console.log("Registered bodyParser.json()");
  app.use(bodyParser.urlencoded({ extended: true }));
  console.log("Registered bodyParser.urlencoded()");

  // Load main vehicles router (all other vehicle routes)
  console.log("Loading /api/vehicles...");
  app.use('/api/vehicles', require('./routes/vehicles'));
  console.log("Registered /api/vehicles");

  console.log("Loading /api/auth...");
  app.use('/api/auth', require('./routes/auth'));
  console.log("Registered /api/auth");

  console.log("Loading /api/users...");
  app.use('/api/users', require('./routes/users'));
  console.log("Registered /api/users");

  console.log("Loading /api/bookings...");
  app.use('/api/bookings', require('./routes/bookings'));
  console.log("Registered /api/bookings");

  console.log("Loading /api/feedback...");
  app.use('/api/feedback', require('./routes/feedback'));
  console.log("Registered /api/feedback");


  console.log("Loading /api/analytics...");
  app.use('/api/analytics', require('./routes/analytics'));
  console.log("Registered /api/analytics");
  console.log("Loading /api/support...");
  app.use('/api/support', require('./routes/support'));
  console.log("Registered /api/support");

  app.use('/api/report', require('./routes/ReportsAnalytics'));
  console.log("Registered /api/report");

  const reportsRoutes = require('./routes/ReportsAnalytics');
  app.use('/api/reports', reportsRoutes);
  console.log("Registered /api/reports");

  console.log("Loading /api/notifications...");
  app.use('/api/notifications', require('./routes/notifications'));

  console.log("Loading /api/admin...");
  app.use('/api/admin', require('./routes/admin'));

  console.log("All routes loaded successfully!");
} catch (err) {
  console.error("Error loading routes:", err);
}

// ----------------------
// Health check endpoint
// ----------------------
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'AutoFleet Hub API is running' });
});

// ----------------------
// Error handling middleware
// ----------------------
app.use((err, req, res, next) => {
  console.error('Error stack:', err.stack);
  
  // Handle multer errors
  if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ 
        success: false,
        message: 'File too large. Maximum size is 10MB per file.' 
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ 
        success: false,
        message: 'Too many files. Maximum is 5 files.' 
      });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ 
        success: false,
        message: 'Unexpected field name in file upload.' 
      });
    }
    return res.status(400).json({ 
      success: false,
      message: `Upload error: ${err.message}` 
    });
  }
  
  // Handle other errors
  res.status(500).json({ 
    success: false,
    error: 'Something went wrong!',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ----------------------
// 404 handler (catch-all)
// ----------------------
app.use((req, res) => {
  res.status(404).json({ 
    success: false,
    error: 'Route not found',
    path: req.path 
  });
});

// ----------------------
// Start server
// ----------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`========================================`);
  console.log(`AutoFleet Hub API server running`);
  console.log(`Port: ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`========================================`);
});

module.exports = app;