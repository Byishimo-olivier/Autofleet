const express = require('express');
const router = express.Router();
console.log('[vehicles-upload.js] Router loaded');

// Test route to confirm router is loaded and mapped
router.get('/test', (req, res) => {
  res.json({ success: true, message: 'vehicle-images router is active' });
});
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('../config/database');
const { authenticateToken, requireOwnerOrAdmin } = require('../middleware/auth');

// Multer storage for dynamic vehicle id folder
const vehicleStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const vehicleId = req.params.id;
    const dir = `uploads/vehicles/${vehicleId}/`;
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'vehicle-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only PNG, JPG, JPEG, and GIF are allowed.'), false);
  }
};
const vehicleUpload = multer({
  storage: vehicleStorage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per file
    files: 5
  }
});

// Upload vehicle images to a specific vehicle folder
router.post('/upload/:id', authenticateToken, requireOwnerOrAdmin, vehicleUpload.array('images', 5), async (req, res) => {
  try {
    console.log('UPLOAD DEBUG: route hit');
    console.log('UPLOAD DEBUG: req.files =', req.files);
    console.log('UPLOAD DEBUG: req.body =', req.body);
    const vehicleId = req.params.id;
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No images uploaded' });
    }
    // Build image paths
    const imagePaths = req.files.map(file => `/uploads/vehicles/${vehicleId}/${file.filename}`);
    // Fetch current images array from DB
    const result = await pool.query('SELECT images FROM vehicles WHERE id = $1', [vehicleId]);
    let currentImages = [];
    if (result.rows.length > 0 && result.rows[0].images) {
      try {
        currentImages = JSON.parse(result.rows[0].images);
        if (!Array.isArray(currentImages)) currentImages = [];
      } catch (e) {
        currentImages = [];
      }
    }
    // Merge new images with existing
    const updatedImages = [...currentImages, ...imagePaths];
    await pool.query('UPDATE vehicles SET images = $1 WHERE id = $2', [JSON.stringify(updatedImages), vehicleId]);
    res.json({ images: updatedImages, message: 'Images uploaded and saved to database successfully' });
  } catch (err) {
    console.error('Image upload error:', err);
    res.status(500).json({ error: 'Failed to upload images' });
  }
});

module.exports = router;
