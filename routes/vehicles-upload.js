const express = require('express');
const router = express.Router();
console.log('[vehicles-upload.js] Router loaded');

// Test route to confirm router is loaded and mapped
router.get('/test', (req, res) => {
  res.json({ success: true, message: 'vehicle-images router is active' });
});
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('cloudinary').v2;
const pool = require('../config/database');
const { authenticateToken, requireOwnerOrAdmin } = require('../middleware/auth');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: (req, file) => `autofleet/vehicles/${req.params.id}`,
    allowed_formats: ['png', 'jpg', 'jpeg', 'gif'],
  },
});

const vehicleUpload = multer({
  storage: storage,
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
    // Build image paths from Cloudinary secure_url
    const imagePaths = req.files.map(file => file.path); // Cloudinary sets URL in file.path
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
