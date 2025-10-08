const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('../config/database');
const { authenticateToken, requireOwnerOrAdmin } = require('../middleware/auth');
const { successResponse, errorResponse, validateImageFile } = require('../utils/helpers');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/vehicles/');
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

const upload = multer({ 
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per file
    files: 5 // Maximum 5 files
  }
});

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
const vehicleUpload = multer({
  storage: vehicleStorage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per file
    files: 5
  }
});

// Helper function to parse images with multiple storage formats
const parseVehicleImages = (images, vehicleId) => {
  console.log(`Parsing images for vehicle ${vehicleId}:`, images);
  console.log('Images type:', typeof images);
  
  let parsedImages = [];
  
  try {
    if (Array.isArray(images)) {
      // Already an array - handle both storage formats
      parsedImages = images;
      console.log('Images already parsed as array:', parsedImages);
    } else if (images && typeof images === 'string' && images.trim() !== '') {
      // String format - needs parsing
      parsedImages = JSON.parse(images);
      console.log('Parsed images from string:', parsedImages);
    } else {
      // No images
      parsedImages = [];
      console.log('No images found or empty');
    }
    
    // Handle different storage formats:
    // Format 1: ["/uploads/vehicles/56/vehicle-123.jpg"] (with vehicle ID folder)
    // Format 2: ["/uploads/vehicles/vehicle-123.jpg"] (without vehicle ID folder)
    console.log('Final parsed images array:', parsedImages);
    console.log('Images array length:', parsedImages.length);
    
    return parsedImages;
  } catch (e) {
    console.log('Failed to parse images:', e.message);
    return [];
  }
};

// Get all vehicles with filtering, search, bookings count, and pagination
router.get('/', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      type,
      minPrice,
      maxPrice,
      location, // Pickup location
      pickupDate,
      returnDate,
      status,
      search,
      sortBy = 'created_at',
      sortOrder = 'DESC',
      listing_type
    } = req.query;

    const offset = (page - 1) * limit;
    let sql = `SELECT v.*, u.first_name as owner_first_name, u.last_name as owner_last_name, u.phone as owner_phone, 
      (SELECT COUNT(*) FROM bookings b WHERE b.vehicle_id = v.id) as bookings_count
      FROM vehicles v LEFT JOIN users u ON v.owner_id = u.id WHERE 1=1`;
    let params = [];
    let idx = 1;

    // Basic filters
    if (status) { sql += ` AND v.status = $${idx++}`; params.push(status); }
    if (type) { sql += ` AND v.type = $${idx++}`; params.push(type); }
    if (listing_type) { sql += ` AND v.listing_type = $${idx++}`; params.push(listing_type); }
    
    // Location filter (pickup location)
    if (location) { 
      sql += ` AND v.location_address ILIKE $${idx++}`; 
      params.push(`%${location}%`); 
    }

    // Date availability filter - check if vehicle is available during requested period
    if (pickupDate && returnDate) {
      sql += ` AND v.id NOT IN (
        SELECT DISTINCT b.vehicle_id 
        FROM bookings b 
        WHERE b.status IN ('confirmed', 'active') 
        AND (
          (b.start_date <= $${idx} AND b.end_date >= $${idx}) OR
          (b.start_date <= $${idx + 1} AND b.end_date >= $${idx + 1}) OR
          (b.start_date >= $${idx} AND b.end_date <= $${idx + 1})
        )
      )`;
      params.push(pickupDate, pickupDate, returnDate, returnDate, pickupDate, returnDate);
      idx += 2;
    }
    
    // Price filtering - handle both rent and sale
    if (minPrice) { 
      sql += ` AND (
        (v.listing_type = 'rent' AND v.daily_rate >= $${idx}) OR 
        (v.listing_type = 'sale' AND v.selling_price >= $${idx}) OR
        (v.listing_type IS NULL AND v.daily_rate >= $${idx})
      )`; 
      params.push(parseFloat(minPrice)); 
      idx++;
    }
    if (maxPrice) { 
      sql += ` AND (
        (v.listing_type = 'rent' AND v.daily_rate <= $${idx}) OR 
        (v.listing_type = 'sale' AND v.selling_price <= $${idx}) OR
        (v.listing_type IS NULL AND v.daily_rate <= $${idx})
      )`; 
      params.push(parseFloat(maxPrice)); 
      idx++;
    }

    // Search filter
    if (search) {
      sql += ` AND (v.make ILIKE $${idx} OR v.model ILIKE $${idx+1} OR v.description ILIKE $${idx+2})`;
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
      idx += 3;
    }

    // Validate sort parameters
    const allowedSortFields = ['created_at', 'daily_rate', 'selling_price', 'make', 'model', 'year'];
    const validSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'created_at';
    const validSortOrder = ['ASC', 'DESC'].includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';
    sql += ` ORDER BY v.${validSortBy} ${validSortOrder} LIMIT $${idx++} OFFSET $${idx}`;
    params.push(parseInt(limit), parseInt(offset));
    
    const vehiclesResult = await pool.query(sql, params);
    
    console.log('=== GET ALL VEHICLES DEBUG ===');
    console.log('Raw vehicles from DB:', vehiclesResult.rows.length, 'vehicles found');
    console.log('Applied filters:', { type, location, pickupDate, returnDate, minPrice, maxPrice, search, listing_type });
    
    let vehicles = vehiclesResult.rows.map(vehicle => {
      console.log(`\nVehicle ID ${vehicle.id}:`);
      console.log('Raw images field from DB:', vehicle.images);
      
      let features = [];
      try {
        features = vehicle.features && typeof vehicle.features === 'string' && vehicle.features.trim() !== '' ? JSON.parse(vehicle.features) : [];
      } catch (e) { 
        console.log('Failed to parse features:', e.message);
        features = []; 
      }
      
      // Use helper function to parse images
      const images = parseVehicleImages(vehicle.images, vehicle.id);
      const firstImage = images && images.length > 0 ? images[0] : null;
      console.log('First image selected:', firstImage);
      
      // Determine price based on listing type
      let displayPrice = null;
      let priceLabel = '';
      let priceType = vehicle.listing_type || 'rent';
      
      if (priceType === 'sale') {
        displayPrice = vehicle.selling_price;
        priceLabel = 'For Sale';
      } else {
        displayPrice = vehicle.daily_rate;
        priceLabel = 'Per Day';
      }
      
      return {
        ...vehicle,
        features,
        images,
        bookings: vehicle.bookings_count || 0,
        price: displayPrice, // Main price field
        daily_rate: vehicle.daily_rate, // Keep original for rent
        selling_price: vehicle.selling_price, // Keep original for sale
        listing_type: priceType,
        price_label: priceLabel,
        plate: vehicle.license_plate,
        status: vehicle.status ? vehicle.status.charAt(0).toUpperCase() + vehicle.status.slice(1) : '',
        type: vehicle.type ? vehicle.type.charAt(0).toUpperCase() + vehicle.type.slice(1) : '',
        image: firstImage
      };
    });
    
    console.log('=== FINAL VEHICLES RESPONSE ===');
    vehicles.forEach((v, index) => {
      console.log(`Vehicle ${index + 1}: ID=${v.id}, listing_type=${v.listing_type}, price=${v.price}, price_label=${v.price_label}, image=${v.image}, images_count=${v.images?.length || 0}`);
    });
    
    // Updated count query to match all filters
    let countSql = 'SELECT COUNT(*) as total FROM vehicles v WHERE 1=1';
    let countParams = [];
    let countIdx = 1;
    
    if (status) { countSql += ` AND v.status = $${countIdx++}`; countParams.push(status); }
    if (type) { countSql += ` AND v.type = $${countIdx++}`; countParams.push(type); }
    if (listing_type) { countSql += ` AND v.listing_type = $${countIdx++}`; countParams.push(listing_type); }
    if (location) { countSql += ` AND v.location_address ILIKE $${countIdx++}`; countParams.push(`%${location}%`); }
    
    // Date availability for count
    if (pickupDate && returnDate) {
      countSql += ` AND v.id NOT IN (
        SELECT DISTINCT b.vehicle_id 
        FROM bookings b 
        WHERE b.status IN ('confirmed', 'active') 
        AND (
          (b.start_date <= $${countIdx} AND b.end_date >= $${countIdx}) OR
          (b.start_date <= $${countIdx + 1} AND b.end_date >= $${countIdx + 1}) OR
          (b.start_date >= $${countIdx} AND b.end_date <= $${countIdx + 1})
        )
      )`;
      countParams.push(pickupDate, pickupDate, returnDate, returnDate, pickupDate, returnDate);
      countIdx += 2;
    }
    
    if (minPrice) { 
      countSql += ` AND (
        (v.listing_type = 'rent' AND v.daily_rate >= $${countIdx}) OR 
        (v.listing_type = 'sale' AND v.selling_price >= $${countIdx})
      )`; 
      countParams.push(parseFloat(minPrice)); 
      countIdx++;
    }
    if (maxPrice) { 
      countSql += ` AND (
        (v.listing_type = 'rent' AND v.daily_rate <= $${countIdx}) OR 
        (v.listing_type = 'sale' AND v.selling_price <= $${countIdx})
      )`; 
      countParams.push(parseFloat(maxPrice)); 
      countIdx++;
    }
    if (search) {
      countSql += ` AND (v.make ILIKE $${countIdx} OR v.model ILIKE $${countIdx+1} OR v.description ILIKE $${countIdx+2})`;
      const searchTerm = `%${search}%`;
      countParams.push(searchTerm, searchTerm, searchTerm);
      countIdx += 3;
    }
    
    const countResult = await pool.query(countSql, countParams);
    const total = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(total / limit);
    
    successResponse(res, {
      vehicles,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalVehicles: total,
        hasNext: page < totalPages,
        hasPrev: page > 1
      },
      filters: {
        type,
        location,
        pickupDate,
        returnDate,
        minPrice,
        maxPrice,
        search,
        listing_type,
        sortBy: validSortBy,
        sortOrder: validSortOrder
      }
    }, 'Vehicles retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Database error', 500);
  }
});

// Get featured vehicles with same filtering capability
router.get('/featured', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 3,
      type,
      location,
      pickupDate,
      returnDate,
      minPrice,
      maxPrice,
      search,
      sortBy = 'created_at',
      sortOrder = 'DESC'
    } = req.query;

    const offset = (page - 1) * limit;
    
    // Build dynamic SQL query with filters
    let sql = `SELECT v.*, 
      (SELECT COUNT(*) FROM bookings b WHERE b.vehicle_id = v.id) as bookings_count
      FROM vehicles v WHERE v.status = 'available'`;
    let params = [];
    let idx = 1;

    // Add filters
    if (type) { 
      sql += ` AND v.type = $${idx++}`; 
      params.push(type); 
    }
    if (location) { 
      sql += ` AND v.location_address ILIKE $${idx++}`; 
      params.push(`%${location}%`); 
    }

    // Date availability filter
    if (pickupDate && returnDate) {
      sql += ` AND v.id NOT IN (
        SELECT DISTINCT b.vehicle_id 
        FROM bookings b 
        WHERE b.status IN ('confirmed', 'active') 
        AND (
          (b.start_date <= $${idx} AND b.end_date >= $${idx}) OR
          (b.start_date <= $${idx + 1} AND b.end_date >= $${idx + 1}) OR
          (b.start_date >= $${idx} AND b.end_date <= $${idx + 1})
        )
      )`;
      params.push(pickupDate, pickupDate, returnDate, returnDate, pickupDate, returnDate);
      idx += 2;
    }

    if (minPrice) { 
      sql += ` AND (
        (v.listing_type = 'rent' AND v.daily_rate >= $${idx}) OR 
        (v.listing_type = 'sale' AND v.selling_price >= $${idx})
      )`; 
      params.push(parseFloat(minPrice)); 
      idx++;
    }
    if (maxPrice) { 
      sql += ` AND (
        (v.listing_type = 'rent' AND v.daily_rate <= $${idx}) OR 
        (v.listing_type = 'sale' AND v.selling_price <= $${idx})
      )`; 
      params.push(parseFloat(maxPrice)); 
      idx++;
    }
    if (search) {
      sql += ` AND (v.make ILIKE $${idx} OR v.model ILIKE $${idx+1} OR v.description ILIKE $${idx+2})`;
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
      idx += 3;
    }

    // Validate sort parameters
    const allowedSortFields = ['created_at', 'daily_rate', 'selling_price', 'make', 'model', 'year'];
    const validSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'created_at';
    const validSortOrder = ['ASC', 'DESC'].includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';
    
    sql += ` ORDER BY v.${validSortBy} ${validSortOrder}, bookings_count DESC LIMIT $${idx++} OFFSET $${idx}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(sql, params);

    console.log('=== GET FEATURED VEHICLES DEBUG ===');
    console.log('Raw featured vehicles from DB:', result.rows.length, 'vehicles found');
    console.log('Applied filters:', { type, location, pickupDate, returnDate, minPrice, maxPrice, search });

    // Get total count for pagination (same filters)
    let countSql = `SELECT COUNT(*) FROM vehicles v WHERE v.status = 'available'`;
    let countParams = [];
    let countIdx = 1;

    if (type) { countSql += ` AND v.type = $${countIdx++}`; countParams.push(type); }
    if (location) { countSql += ` AND v.location_address ILIKE $${countIdx++}`; countParams.push(`%${location}%`); }
    
    if (pickupDate && returnDate) {
      countSql += ` AND v.id NOT IN (
        SELECT DISTINCT b.vehicle_id 
        FROM bookings b 
        WHERE b.status IN ('confirmed', 'active') 
        AND (
          (b.start_date <= $${countIdx} AND b.end_date >= $${countIdx}) OR
          (b.start_date <= $${countIdx + 1} AND b.end_date >= $${countIdx + 1}) OR
          (b.start_date >= $${countIdx} AND b.end_date <= $${countIdx + 1})
        )
      )`;
      countParams.push(pickupDate, pickupDate, returnDate, returnDate, pickupDate, returnDate);
      countIdx += 2;
    }
    
    if (minPrice) { 
      countSql += ` AND (
        (v.listing_type = 'rent' AND v.daily_rate >= $${countIdx}) OR 
        (v.listing_type = 'sale' AND v.selling_price >= $${countIdx})
      )`; 
      countParams.push(parseFloat(minPrice)); 
      countIdx++;
    }
    if (maxPrice) { 
      countSql += ` AND (
        (v.listing_type = 'rent' AND v.daily_rate <= $${countIdx}) OR 
        (v.listing_type = 'sale' AND v.selling_price <= $${countIdx})
      )`; 
      countParams.push(parseFloat(maxPrice)); 
      countIdx++;
    }
    if (search) {
      countSql += ` AND (v.make ILIKE $${countIdx} OR v.model ILIKE $${countIdx+1} OR v.description ILIKE $${countIdx+2})`;
      const searchTerm = `%${search}%`;
      countParams.push(searchTerm, searchTerm, searchTerm);
      countIdx += 3;
    }

    const countResult = await pool.query(countSql, countParams);
    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / limit);

    const vehicles = result.rows.map(vehicle => {
      console.log(`\nFeatured Vehicle ID ${vehicle.id}:`);
      console.log('Raw images field from DB:', vehicle.images);
      
      // Use helper function to parse images
      const images = parseVehicleImages(vehicle.images, vehicle.id);
      const firstImage = images && images.length > 0 ? images[0] : null;
      console.log('First image selected for featured:', firstImage);
      
      // Determine price based on listing type
      let displayPrice = null;
      let priceLabel = '';
      let priceType = vehicle.listing_type || 'rent';
      
      if (priceType === 'sale') {
        displayPrice = vehicle.selling_price;
        priceLabel = 'For Sale';
      } else {
        displayPrice = vehicle.daily_rate;
        priceLabel = 'Per Day';
      }
      
      return {
        id: vehicle.id,
        name: vehicle.make + ' ' + vehicle.model,
        price: displayPrice,
        daily_rate: vehicle.daily_rate,
        selling_price: vehicle.selling_price,
        listing_type: priceType,
        price_label: priceLabel,
        type: (vehicle.type ? vehicle.type.charAt(0).toUpperCase() + vehicle.type.slice(1) : '') + ' • ' + (vehicle.transmission ? vehicle.transmission.charAt(0).toUpperCase() + vehicle.transmission.slice(1) : ''),
        status: vehicle.status ? vehicle.status.charAt(0).toUpperCase() + vehicle.status.slice(1) : '',
        img: firstImage,
        rating: 4.8,
        reviews: 127
      };
    });

    console.log('=== FINAL FEATURED VEHICLES RESPONSE ===');
    vehicles.forEach((v, index) => {
      console.log(`Featured Vehicle ${index + 1}: ID=${v.id}, listing_type=${v.listing_type}, price=${v.price}, price_label=${v.price_label}, img=${v.img}`);
    });

    successResponse(res, {
      vehicles,
      pagination: {
        currentPage: page,
        totalPages,
        totalVehicles: total,
        hasNext: page < totalPages,
        hasPrev: page > 1
      },
      filters: {
        type,
        location,
        pickupDate,
        returnDate,
        minPrice,
        maxPrice,
        search,
        sortBy: validSortBy,
        sortOrder: validSortOrder
      }
    }, 'Featured vehicles retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Database error', 500);
  }
});

// Get vehicle by ID
router.get('/:id', async (req, res) => {
  const vehicleId = req.params.id;
  try {
    const result = await pool.query(`
      SELECT v.*, u.first_name as owner_first_name, u.last_name as owner_last_name, u.phone as owner_phone, u.email as owner_email
      FROM vehicles v
      LEFT JOIN users u ON v.owner_id = u.id
      WHERE v.id = $1
    `, [vehicleId]);
    const vehicle = result.rows[0];
    if (!vehicle) {
      return errorResponse(res, 'Vehicle not found', 404);
    }
    
    console.log(`=== GET VEHICLE BY ID DEBUG (ID: ${vehicleId}) ===`);
    console.log('Raw images field from DB:', vehicle.images);
    
    try {
      vehicle.features = vehicle.features ? JSON.parse(vehicle.features) : [];
      
      // Use helper function to parse images
      vehicle.images = parseVehicleImages(vehicle.images, vehicleId);
      
      // Add price information based on listing type
      const priceType = vehicle.listing_type || 'rent';
      let displayPrice = null;
      let priceLabel = '';
      
      if (priceType === 'sale') {
        displayPrice = vehicle.selling_price;
        priceLabel = 'For Sale';
      } else {
        displayPrice = vehicle.daily_rate;
        priceLabel = 'Per Day';
      }
      
      vehicle.price = displayPrice;
      vehicle.price_label = priceLabel;
      
    } catch (e) {
      console.log('Failed to parse vehicle data:', e.message);
      vehicle.features = [];
      vehicle.images = [];
    }
    
    successResponse(res, vehicle, 'Vehicle retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Database error', 500);
  }
});

// Add new vehicle (owners and admins only)
router.post(
  '/',
  authenticateToken,
  requireOwnerOrAdmin,
  async (req, res) => {
    try {
      console.log('BODY:', req.body);
      const {
        make,
        model,
        year,
        category,
        type,
        plateNumber,
        licensePlate,
        color,
        seats,
        transmission,
        fuelType,
        daily_rate,
        description,
        features,
        images,
        locationLat,
        locationLng,
        locationAddress,
        listing_type,
        selling_price
      } = req.body;

      const vehicleType = (category || type || '').toLowerCase();
      const license_plate = plateNumber || licensePlate;
      let dailyRateValue = daily_rate;
      let listingTypeVal = listing_type ? listing_type.trim() : 'rent';
      let sellingPriceVal = selling_price ? parseFloat(selling_price) : null;

      if (listingTypeVal === 'rent') {
        sellingPriceVal = null;
      }
      if (listingTypeVal === 'sale') {
        dailyRateValue = null;
      }

      // Validate required fields
      if (!make || !make.trim()) return errorResponse(res, 'Make is required', 400);
      if (!model || !model.trim()) return errorResponse(res, 'Model is required', 400);
      if (!year || !year.toString().trim()) return errorResponse(res, 'Year is required', 400);
      if (!vehicleType || !vehicleType.trim()) return errorResponse(res, 'Type is required', 400);
      if (!license_plate || !license_plate.trim()) return errorResponse(res, 'License plate is required', 400);

      // Validate vehicle type
      if (!['sedan', 'suv', 'van', 'truck'].includes(vehicleType)) {
        return errorResponse(res, 'Invalid vehicle type. Must be sedan, suv, van, or truck', 400);
      }

      // Validate year
      const yearNum = parseInt(year);
      if (isNaN(yearNum) || yearNum < 1900 || yearNum > 2030) {
        return errorResponse(res, 'Invalid year. Must be between 1900 and 2030', 400);
      }

      // Validate daily rate or selling price
      if (listingTypeVal === 'rent') {
        const dailyRateNum = parseFloat(dailyRateValue);
        if (isNaN(dailyRateNum) || dailyRateNum <= 0) {
          return errorResponse(res, 'Daily rate must be greater than 0', 400);
        }
      }
      if (listingTypeVal === 'sale') {
        if (isNaN(sellingPriceVal) || sellingPriceVal <= 0) {
          return errorResponse(res, 'Selling price must be greater than 0', 400);
        }
      }

      const colorVal = color ? color.trim() : null;
      const seatsVal = seats ? parseInt(seats) : null;
      const transmissionVal = transmission ? transmission.trim() : null;
      const fuelTypeVal = fuelType ? fuelType.trim() : null;
      const descriptionVal = description ? description.trim() : null;
      const featuresVal = features
        ? Array.isArray(features)
          ? features
          : typeof features === 'string'
            ? features.split(',').map(f => f.trim())
            : []
        : [];
      const imagesVal = images
        ? Array.isArray(images)
          ? images
          : typeof images === 'string'
            ? [images]
            : []
        : [];
      const locationLatVal = locationLat ? parseFloat(locationLat) : null;
      const locationLngVal = locationLng ? parseFloat(locationLng) : null;
      const locationAddressVal = locationAddress ? locationAddress.trim() : null;

      if (imagesVal.length > 10) {
        return errorResponse(res, 'Maximum 10 images allowed', 400);
      }

      const sql = `
        INSERT INTO vehicles (
          owner_id, make, model, year, type, license_plate, color, seats, transmission,
          fuel_type, daily_rate, description, features, images, status, location_lat, location_lng, location_address, listing_type, selling_price
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        RETURNING id
      `;
      const params = [
        req.user.id,
        make.trim(),
        model.trim(),
        parseInt(year),
        vehicleType,
        license_plate.trim(),
        color ? color.trim() : null,
        seats ? parseInt(seats) : null,
        transmission ? transmission.trim() : null,
        fuelType ? fuelType.trim() : null,
        listingTypeVal === 'rent' ? parseFloat(dailyRateValue) : null,
        description ? description.trim() : null,
        JSON.stringify(
          features
            ? Array.isArray(features)
              ? features
              : typeof features === 'string'
                ? features.split(',').map(f => f.trim())
                : []
            : []
        ),
        JSON.stringify(
          images
            ? Array.isArray(images)
              ? images
              : typeof images === 'string'
                ? [images]
                : []
            : []
        ),
        'available',
        locationLat ? parseFloat(locationLat) : null,
        locationLng ? parseFloat(locationLng) : null,
        locationAddress ? locationAddress.trim() : null,
        listingTypeVal,
        listingTypeVal === 'sale' ? sellingPriceVal : null
      ];

      const result = await pool.query(sql, params);
      successResponse(res, { vehicleId: result.rows[0].id }, 'Vehicle added successfully', 201);
    } catch (error) {
      console.error('Add vehicle error:', error);

      if (error.code === '23505') {
        return errorResponse(res, 'Vehicle with this license plate already exists', 409);
      }
      errorResponse(res, 'Internal server error', 500);
    }
  }
);

// Update vehicle
router.put('/:id', authenticateToken, requireOwnerOrAdmin, async (req, res) => {
  try {
    const vehicleId = req.params.id;
    const userId = req.user.id;
    const userRole = req.user.role;

    const vehicleResult = await pool.query('SELECT owner_id FROM vehicles WHERE id = $1', [vehicleId]);
    const vehicle = vehicleResult.rows[0];

    if (!vehicle) {
      return errorResponse(res, 'Vehicle not found', 404);
    }

    if (userRole !== 'admin' && vehicle.owner_id !== userId) {
      return errorResponse(res, 'Access denied', 403);
    }

    const {
      make, model, year, type, licensePlate, color, seats,
      transmission, fuelType, dailyRate, description, features,
      images,
      locationLat, locationLng, locationAddress, status
    } = req.body;

    let updateFields = [];
    let params = [];
    let idx = 1;

    if (make) { updateFields.push(`make = $${idx++}`); params.push(make); }
    if (model) { updateFields.push(`model = $${idx++}`); params.push(model); }
    if (year) { updateFields.push(`year = $${idx++}`); params.push(parseInt(year)); }
    if (type) {
      if (!['sedan', 'suv', 'van', 'truck'].includes(type)) {
        return errorResponse(res, 'Invalid vehicle type', 400);
      }
      updateFields.push(`type = $${idx++}`); params.push(type);
    }
    if (licensePlate) { updateFields.push(`license_plate = $${idx++}`); params.push(licensePlate); }
    if (color) { updateFields.push(`color = $${idx++}`); params.push(color); }
    if (seats) { updateFields.push(`seats = $${idx++}`); params.push(parseInt(seats)); }
    if (transmission) { updateFields.push(`transmission = $${idx++}`); params.push(transmission); }
    if (fuelType) { updateFields.push(`fuel_type = $${idx++}`); params.push(fuelType); }
    if (dailyRate) {
      if (dailyRate <= 0) {
        return errorResponse(res, 'Daily rate must be greater than 0', 400);
      }
      updateFields.push(`daily_rate = $${idx++}`); params.push(parseFloat(dailyRate));
    }
    if (description !== undefined) { updateFields.push(`description = $${idx++}`); params.push(description); }
    if (features) {
      try {
        const parsedFeatures = typeof features === 'string' ? JSON.parse(features) : features;
        updateFields.push(`features = $${idx++}`); params.push(JSON.stringify(parsedFeatures));
      } catch (e) {
        return errorResponse(res, 'Invalid features format', 400);
      }
    }
    if (images) {
      try {
        const parsedImages = Array.isArray(images)
          ? images
          : typeof images === 'string'
            ? [images]
            : [];
        updateFields.push(`images = $${idx++}`); params.push(JSON.stringify(parsedImages));
      } catch (e) {
        return errorResponse(res, 'Invalid images format', 400);
      }
    }
    if (locationLat !== undefined) { updateFields.push(`location_lat = $${idx++}`); params.push(locationLat ? parseFloat(locationLat) : null); }
    if (locationLng !== undefined) { updateFields.push(`location_lng = $${idx++}`); params.push(locationLng ? parseFloat(locationLng) : null); }
    if (locationAddress !== undefined) { updateFields.push(`location_address = $${idx++}`); params.push(locationAddress); }
    if (status) {
      if (!['available', 'rented', 'maintenance', 'inactive'].includes(status)) {
        return errorResponse(res, 'Invalid status', 400);
      }
      updateFields.push(`status = $${idx++}`); params.push(status);
    }

    if (updateFields.length === 0) {
      return errorResponse(res, 'No fields to update', 400);
    }

    updateFields.push(`updated_at = NOW()`);

    const sql = `UPDATE vehicles SET ${updateFields.join(', ')} WHERE id = $${idx}`;
    params.push(vehicleId);

    const result = await pool.query(sql, params);

    if (result.rowCount === 0) {
      return errorResponse(res, 'Vehicle not found', 404);
    }

    successResponse(res, null, 'Vehicle updated successfully');
  } catch (error) {
    console.error('Update vehicle error:', error);

    if (error.code === '23505') {
      return errorResponse(res, 'Vehicle with this license plate already exists', 409);
    }

    errorResponse(res, 'Internal server error', 500);
  }
});

// Delete vehicle
router.delete('/:id', authenticateToken, requireOwnerOrAdmin, async (req, res) => {
  const vehicleId = req.params.id;
  const userId = req.user.id;
  const userRole = req.user.role;
  
  try {
    const vehicleResult = await pool.query('SELECT owner_id FROM vehicles WHERE id = $1', [vehicleId]);
    const vehicle = vehicleResult.rows[0];
    
    if (!vehicle) {
      return errorResponse(res, 'Vehicle not found', 404);
    }
    
    if (userRole !== 'admin' && vehicle.owner_id !== userId) {
      return errorResponse(res, 'Access denied', 403);
    }
    
    const activeBookingsResult = await pool.query(
      `SELECT COUNT(*) as activeBookings FROM bookings WHERE vehicle_id = $1 AND status IN ('pending', 'confirmed', 'active')`,
      [vehicleId]
    );
    
    if (parseInt(activeBookingsResult.rows[0].activebookings) > 0) {
      return errorResponse(res, 'Cannot delete vehicle with active bookings', 400);
    }
    
    const deleteResult = await pool.query('DELETE FROM vehicles WHERE id = $1', [vehicleId]);
    
    if (deleteResult.rowCount === 0) {
      return errorResponse(res, 'Vehicle not found', 404);
    }
    
    successResponse(res, null, 'Vehicle deleted successfully');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Failed to delete vehicle', 500);
  }
});

// Get vehicles by owner
router.get('/owner/:ownerId', authenticateToken, async (req, res) => {
  const ownerId = req.params.ownerId;
  const requestingUserId = req.user.id;
  const requestingUserRole = req.user.role;
  
  if (requestingUserRole !== 'admin' && parseInt(ownerId) !== requestingUserId) {
    return errorResponse(res, 'Access denied', 403);
  }
  
  try {
    const result = await pool.query(
      `SELECT * FROM vehicles WHERE owner_id = $1 ORDER BY created_at DESC`,
      [ownerId]
    );
    
    let vehicles = result.rows.map(vehicle => {
      // Determine price based on listing type
      const priceType = vehicle.listing_type || 'rent';
      let displayPrice = null;
      let priceLabel = '';
      
      if (priceType === 'sale') {
        displayPrice = vehicle.selling_price;
        priceLabel = 'For Sale';
      } else {
        displayPrice = vehicle.daily_rate;
        priceLabel = 'Per Day';
      }
      
      return {
        ...vehicle,
        features: vehicle.features ? JSON.parse(vehicle.features) : [],
        images: parseVehicleImages(vehicle.images, vehicle.id),
        price: displayPrice,
        price_label: priceLabel
      };
    });
    
    successResponse(res, vehicles, 'Owner vehicles retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Database error', 500);
  }
});

// Upload images for a vehicle
router.post(
  '/upload/:id',
  authenticateToken,
  requireOwnerOrAdmin,
  vehicleUpload.array('images', 5),
  async (req, res) => {
    try {
      const vehicleId = req.params.id;
      const userId = req.user.id;
      const userRole = req.user.role;

      console.log('=== IMAGE UPLOAD DEBUG ===');
      console.log('Upload request for vehicle:', vehicleId);
      console.log('Files received:', req.files);
      console.log('Number of files:', req.files ? req.files.length : 0);

      if (!req.files || req.files.length === 0) {
        console.log('❌ No files received in upload request');
        return errorResponse(res, 'No images provided', 400);
      }

      const vehicleResult = await pool.query('SELECT owner_id, images FROM vehicles WHERE id = $1', [vehicleId]);
      const vehicle = vehicleResult.rows[0];
      
      if (!vehicle) {
        console.log('❌ Vehicle not found:', vehicleId);
        req.files.forEach(file => {
          try {
            fs.unlinkSync(file.path);
          } catch (e) {
            console.error('Failed to delete file:', file.path);
          }
        });
        return errorResponse(res, 'Vehicle not found', 404);
      }
      
      if (userRole !== 'admin' && vehicle.owner_id !== userId) {
        console.log('❌ Access denied for user:', userId, 'vehicle owner:', vehicle.owner_id);
        req.files.forEach(file => {
          try {
            fs.unlinkSync(file.path);
          } catch (e) {
            console.error('Failed to delete file:', file.path);
          }
        });
        return errorResponse(res, 'Access denied', 403);
      }

      // Process file paths
      const uploadedFiles = req.files.map(file => {
        console.log('Processing file:', file.filename, 'path:', file.path);
        return file.path.replace(/\\/g, '/');
      });
      console.log('✅ Processed uploaded file paths:', uploadedFiles);

      let existingImages = [];
      try {
        existingImages = vehicle.images ? JSON.parse(vehicle.images) : [];
        console.log('Existing images in DB:', existingImages);
      } catch (e) {
        console.error('Failed to parse existing images:', e);
        existingImages = [];
      }

      const allImages = [...existingImages, ...uploadedFiles];
      console.log('All images (existing + new):', allImages);

      if (allImages.length > 10) {
        console.log('❌ Too many images. Total:', allImages.length);
        req.files.forEach(file => {
          try {
            fs.unlinkSync(file.path);
          } catch (e) {
            console.error('Failed to delete file:', file.path);
          }
        });
        return errorResponse(res, 'Maximum 10 images allowed per vehicle. Current: ' + existingImages.length, 400);
      }

      // Update database
      const updateResult = await pool.query('UPDATE vehicles SET images = $1, updated_at = NOW() WHERE id = $2', [
        JSON.stringify(allImages),
        vehicleId
      ]);
      
      console.log('✅ Database update result:', updateResult.rowCount, 'rows affected');
      console.log('✅ Images stored in DB:', JSON.stringify(allImages));
      console.log('Images updated successfully. Total images:', allImages.length);
      
      successResponse(res, { images: allImages, count: allImages.length }, 'Images uploaded successfully');
    } catch (error) {
      console.error('❌ Upload error:', error);
      
      if (req.files && req.files.length > 0) {
        req.files.forEach(file => {
          try {
            fs.unlinkSync(file.path);
          } catch (e) {
            console.error('Failed to delete file:', file.path);
          }
        });
      }
      
      errorResponse(res, 'Failed to upload images: ' + error.message, 500);
    }
  }
);

// Get image URL with placeholder and server URL
const getImageUrl = (imagePath) => {
  if (!imagePath) return "/placeholder.png";
  
  // If it's already a full URL, return as-is
  if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
    return imagePath;
  }
  
  // For local images, construct URL with your server base
  const serverUrl = 'http://localhost:5000'; // or import.meta.env.VITE_SERVER_URL
  
  // Ensure single leading slash
  const normalizedPath = imagePath.startsWith('/') ? imagePath : `/${imagePath}`;
  
  return `${serverUrl}${normalizedPath}`;
};

// Usage in your components:
// <img src={getImageUrl(vehicle.img)} alt="Vehicle" />

module.exports = router;