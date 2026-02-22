const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('../config/database');
const { authenticateToken, requireOwnerOrAdmin } = require('../middleware/auth');

console.log('[vehicles-upload.js] Router loaded');

// Test route to confirm router is loaded and mapped
router.get('/test', (req, res) => {
  res.json({ success: true, message: 'vehicle-images router is active' });
});

// Try to use Cloudinary if configured, otherwise fall back to local storage
let vehicleUpload;
const useCloudinary = process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET;

console.log('🔍 Cloudinary config check:', {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME ? '✅ set' : '❌ missing',
  api_key: process.env.CLOUDINARY_API_KEY ? '✅ set' : '❌ missing',
  api_secret: process.env.CLOUDINARY_API_SECRET ? '✅ set' : '❌ missing',
  useCloudinary
});

if (useCloudinary) {
  // ✅ CLOUDINARY STORAGE
  const { CloudinaryStorage } = require('multer-storage-cloudinary');
  const cloudinary = require('cloudinary').v2;
  
  console.log('📦 Configuring Cloudinary with:', {
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY ? process.env.CLOUDINARY_API_KEY.substring(0, 5) + '...' : 'undefined',
    api_secret: process.env.CLOUDINARY_API_SECRET ? process.env.CLOUDINARY_API_SECRET.substring(0, 5) + '...' : 'undefined'
  });
  
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

  vehicleUpload = multer({
    storage: storage,
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB per file
      files: 5
    }
  });
  
  console.log('✅ Using Cloudinary storage for vehicle images');
} else {
  // 📁 FALLBACK: LOCAL DISK STORAGE
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const vehicleId = req.params.id;
      const dir = path.join(__dirname, `../uploads/vehicles/${vehicleId}`);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      cb(null, 'vehicle-' + uniqueSuffix + path.extname(file.originalname));
    }
  });

  // File filter to validate image types
  const fileFilter = (req, file, cb) => {
    const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PNG, JPG, JPEG, and GIF are allowed.'), false);
    }
  };

  vehicleUpload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB per file
      files: 5
    }
  });
  
  console.log('⚠️ Cloudinary not configured. Using local disk storage for vehicle images');
}

// Upload vehicle images to a specific vehicle folder
router.post('/upload/:id', authenticateToken, requireOwnerOrAdmin, vehicleUpload.array('images', 5), async (req, res) => {
  try {
    console.log('UPLOAD DEBUG: route hit');
    console.log('UPLOAD DEBUG: req.files =', req.files);
    console.log('UPLOAD DEBUG: req.body =', req.body);
    const vehicleId = req.params.id;
    const userId = req.user.id;
    const userRole = req.user.role;

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No images uploaded' });
    }

    // Verify ownership - check if vehicle belongs to user or user is admin
    const vehicleCheck = await pool.query('SELECT owner_id FROM vehicles WHERE id = $1', [vehicleId]);
    if (vehicleCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Vehicle not found' });
    }

    const vehicle = vehicleCheck.rows[0];
    if (userRole !== 'admin' && vehicle.owner_id !== userId) {
      // Try comparing as numbers in case of type mismatch
      const ownerIdNum = parseInt(vehicle.owner_id);
      const userIdNum = parseInt(userId);
      if (ownerIdNum !== userIdNum) {
        return res.status(403).json({ error: 'Access denied: You can only upload images for your own vehicles' });
      }
    }

    // Build image paths - handle both Cloudinary and local storage
    const imagePaths = req.files.map(file => {
      // Cloudinary: file.path contains the full URL
      // Local storage: we need to construct the path
      if (file.path && file.path.startsWith('http')) {
        // Cloudinary URL
        return file.path;
      } else if (file.filename) {
        // Local storage - construct relative path for serving via /uploads
        return `/uploads/vehicles/${vehicleId}/${file.filename}`;
      } else if (file.path) {
        // Fallback
        return file.path;
      }
      return null;
    }).filter(Boolean);

    console.log('Image paths to save:', imagePaths);

    // Validate we have paths
    if (imagePaths.length === 0) {
      return res.status(400).json({ error: 'Failed to process uploaded images' });
    }

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
    
    // Update database
    await pool.query('UPDATE vehicles SET images = $1 WHERE id = $2', [JSON.stringify(updatedImages), vehicleId]);
    
    console.log('✅ Images saved successfully. Total images:', updatedImages.length);
    res.json({ 
      success: true,
      images: updatedImages, 
      message: 'Images uploaded and saved to database successfully',
      uploadedCount: imagePaths.length
    });
  } catch (err) {
    console.error('Image upload error:', err);
    res.status(500).json({ error: 'Failed to upload images', details: err.message });
  }
});

module.exports = router;
