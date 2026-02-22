const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('../config/database');
const { authenticateToken, requireOwnerOrAdmin, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse, validateImageFile } = require('../utils/helpers');
const EmailService = require('../Service/EmailService');
const emailService = new EmailService();


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
      listing_type,
      ownerOnly = false // New parameter to filter by current owner
    } = req.query;

    const offset = (page - 1) * limit;
    let params = [];
    let idx = 1;

    // Date availability detection - instead of filtering out, we detect and mark as is_booked
    let isBookedSql = '';
    if (pickupDate && returnDate) {
      isBookedSql = `, (
        SELECT COUNT(*) > 0
        FROM bookings b 
        WHERE b.vehicle_id = v.id 
        AND b.status IN ('confirmed', 'active', 'pending') 
        AND (
          (b.start_date <= $${idx} AND b.end_date >= $${idx}) OR
          (b.start_date <= $${idx + 1} AND b.end_date >= $${idx + 1}) OR
          (b.start_date >= $${idx} AND b.end_date <= $${idx + 1})
        )
      ) as is_booked_on_dates`;
      params.push(pickupDate, returnDate);
      idx += 2;
    } else {
      // Default to checking if booked today if no dates provided
      isBookedSql = `, (
        SELECT COUNT(*) > 0
        FROM bookings b 
        WHERE b.vehicle_id = v.id 
        AND b.status IN ('confirmed', 'active', 'pending') 
        AND b.start_date <= CURRENT_DATE 
        AND b.end_date >= CURRENT_DATE
      ) as is_booked_on_dates`;
    }

    let sql = `SELECT v.*, u.first_name as owner_first_name, u.last_name as owner_last_name, u.phone as owner_phone, 
      (SELECT COUNT(*) FROM bookings b WHERE b.vehicle_id = v.id) as bookings_count
      ${isBookedSql}
      FROM vehicles v LEFT JOIN users u ON v.owner_id = u.id WHERE 1=1`;

    // Filter by owner if ownerOnly is true and user is authenticated
    if (ownerOnly === 'true' || ownerOnly === true) {
      const userId = req.headers['x-user-id']; // Pass user ID from frontend
      if (userId) {
        sql += ` AND v.owner_id = $${idx}`;
        params.push(parseInt(userId));
        idx++;
      }
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
      sql += ` AND (v.make ILIKE $${idx} OR v.model ILIKE $${idx + 1} OR v.description ILIKE $${idx + 2})`;
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
        status: (vehicle.listing_type === 'sale' && (vehicle.status === 'rented' || vehicle.status === 'inactive' || vehicle.is_booked_on_dates))
          ? 'Sold'
          : (vehicle.is_booked_on_dates ? 'Rented' : (vehicle.status ? vehicle.status.charAt(0).toUpperCase() + vehicle.status.slice(1) : '')),
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

    // Add the same filters as the main query
    if (status) { countSql += ` AND v.status = $${countIdx++}`; countParams.push(status); }
    if (type) { countSql += ` AND v.type = $${countIdx++}`; countParams.push(type); }
    if (listing_type) { countSql += ` AND v.listing_type = $${countIdx++}`; countParams.push(listing_type); }
    if (location) { countSql += ` AND v.location_address ILIKE $${countIdx++}`; countParams.push(`%${location}%`); }

    // Add debug logging
    console.log('=== COUNT QUERY DEBUG ===');
    console.log('Count SQL:', countSql);
    console.log('Count Params:', countParams);

    // Replace the count query section with this safer version:

    let total = 0;
    try {
      const countResult = await pool.query(countSql, countParams);
      total = parseInt(countResult.rows[0].total) || 0;
      console.log('Count from query:', total);
    } catch (countError) {
      console.error('Count query failed, using fallback:', countError);
      // Fallback: use the length of vehicles array
      total = vehiclesResult.rows.length;
      console.log('Fallback count:', total);
    }

    // Also add a minimum total check
    if (total === 0 && vehiclesResult.rows.length > 0) {
      total = vehiclesResult.rows.length;
      console.log('Corrected total using vehicles array length:', total);
    }

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

    let params = [];
    let idx = 1;

    // Date availability detection
    let isBookedSql = '';
    if (pickupDate && returnDate) {
      isBookedSql = `, (
        SELECT COUNT(*) > 0
        FROM bookings b 
        WHERE b.vehicle_id = v.id 
        AND b.status IN ('confirmed', 'active', 'pending') 
        AND (
          (b.start_date <= $${idx} AND b.end_date >= $${idx}) OR
          (b.start_date <= $${idx + 1} AND b.end_date >= $${idx + 1}) OR
          (b.start_date >= $${idx} AND b.end_date <= $${idx + 1})
        )
      ) as is_booked_on_dates`;
      params.push(pickupDate, returnDate);
      idx += 2;
    } else {
      // Default to checking if booked today
      isBookedSql = `, (
        SELECT COUNT(*) > 0
        FROM bookings b 
        WHERE b.vehicle_id = v.id 
        AND b.status IN ('confirmed', 'active', 'pending') 
        AND b.start_date <= CURRENT_DATE 
        AND b.end_date >= CURRENT_DATE
      ) as is_booked_on_dates`;
    }

    // Build dynamic SQL query with filters
    let sql = `SELECT v.*, 
      (SELECT COUNT(*) FROM bookings b WHERE b.vehicle_id = v.id) as bookings_count
      ${isBookedSql}
      FROM vehicles v WHERE (v.status = 'available' OR v.status = 'rented')`;

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
      sql += ` AND (v.make ILIKE $${idx} OR v.model ILIKE $${idx + 1} OR v.description ILIKE $${idx + 2})`;
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
      countSql += ` AND (v.make ILIKE $${countIdx} OR v.model ILIKE $${countIdx + 1} OR v.description ILIKE $${countIdx + 2})`;
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
        status: (vehicle.listing_type === 'sale' && (vehicle.status === 'rented' || vehicle.status === 'inactive' || vehicle.is_booked_on_dates))
          ? 'Sold'
          : (vehicle.is_booked_on_dates ? 'Rented' : (vehicle.status ? vehicle.status.charAt(0).toUpperCase() + vehicle.status.slice(1) : '')),
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
      SELECT v.*, u.first_name as owner_first_name, u.last_name as owner_last_name, u.phone as owner_phone, u.email as owner_email,
             (SELECT COUNT(*) > 0 
              FROM bookings b 
              WHERE b.vehicle_id = v.id 
                AND b.status IN ('confirmed', 'active', 'pending')
                AND b.start_date <= CURRENT_DATE 
                AND b.end_date >= CURRENT_DATE) as is_booked_today
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
      // Map status for frontend
      vehicle.status = (vehicle.listing_type === 'sale' && (vehicle.status === 'rented' || vehicle.status === 'inactive' || vehicle.is_booked_today))
        ? 'Sold'
        : (vehicle.is_booked_today ? 'Rented' : (vehicle.status ? vehicle.status.charAt(0).toUpperCase() + vehicle.status.slice(1) : ''));
    } catch (e) {
      console.log('Failed to parse vehicle data:', e.message);
      vehicle.features = [];
      vehicle.images = [];
    }
    // FIX: Add GPS coordinates BEFORE sending response
    vehicle.locationLat = vehicle.location_lat;
    vehicle.locationLng = vehicle.location_lng;
    vehicle.locationAddress = vehicle.location_address;
    console.log('=== VEHICLE GPS DEBUG ===');
    console.log('vehicle.location_lat:', vehicle.location_lat);
    console.log('vehicle.location_lng:', vehicle.location_lng);
    console.log('vehicle.locationLat:', vehicle.locationLat);
    console.log('vehicle.locationLng:', vehicle.locationLng);
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

      // Validation
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
      const locationLatVal = locationLat !== undefined && locationLat !== null ? parseFloat(locationLat) : null;
      const locationLngVal = locationLng !== undefined && locationLng !== null ? parseFloat(locationLng) : null;
      const locationAddressVal = locationAddress ? locationAddress.trim() : null;

      if (imagesVal.length > 10) {
        return errorResponse(res, 'Maximum 10 images allowed', 400);
      }

      // Get owner information for email
      const ownerResult = await pool.query(
        'SELECT first_name, last_name, email FROM users WHERE id = $1',
        [req.user.id]
      );
      const owner = ownerResult.rows[0];

      const statusVal = (listingTypeVal === 'sale') ? 'available' : 'inactive';

      const sql = `
        INSERT INTO vehicles (
          owner_id, make, model, year, type, license_plate, color, seats, transmission,
          fuel_type, daily_rate, description, features, images, status, location_lat, location_lng, location_address, listing_type, selling_price
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        RETURNING *
      `;
      const params = [
        req.user.id,
        make.trim(),
        model.trim(),
        parseInt(year),
        vehicleType,
        license_plate.trim(),
        colorVal,
        seatsVal,
        transmissionVal,
        fuelTypeVal,
        listingTypeVal === 'rent' ? parseFloat(dailyRateValue) : null,
        descriptionVal,
        JSON.stringify(featuresVal),
        JSON.stringify(imagesVal),
        statusVal, // <-- FIXED LINE
        locationLatVal,
        locationLngVal,
        locationAddressVal,
        listingTypeVal,
        listingTypeVal === 'sale' ? sellingPriceVal : null
      ];

      const result = await pool.query(sql, params);
      const newVehicle = result.rows[0];

      // 📧 SEND EMAIL NOTIFICATION TO ADMIN
      try {
        // Send vehicle submission notification to admin
        const adminEmails = process.env.ADMIN_EMAILS ? process.env.ADMIN_EMAILS.split(',') : ['admin@autofleet.com'];

        const subject = `New Vehicle Submission: ${make} ${model} - AutoFleet Hub`;
        const html = `
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; color: #333; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background: #2c3e7d; color: white; padding: 20px; text-align: center; }
              .content { padding: 20px; background: #f9f9f9; }
              .vehicle-details { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; }
              .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
              .button { display: inline-block; background: #28a745; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 10px 5px; }
              .button-danger { background: #dc3545; }
              .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>🚗 New Vehicle Submission</h1>
              </div>
              <div class="content">
                <h2>A new vehicle has been submitted for approval</h2>
                
                <div class="vehicle-details">
                  <h3>🚗 Vehicle Details</h3>
                  <div class="detail-row">
                    <span><strong>Vehicle:</strong></span>
                    <span>${make} ${model} ${year}</span>
                  </div>
                  <div class="detail-row">
                    <span><strong>License Plate:</strong></span>
                    <span>${license_plate}</span>
                  </div>
                  <div class="detail-row">
                    <span><strong>Type:</strong></span>
                    <span>${vehicleType.charAt(0).toUpperCase() + vehicleType.slice(1)}</span>
                  </div>
                  <div class="detail-row">
                    <span><strong>Listing Type:</strong></span>
                    <span>${listingTypeVal === 'rent' ? 'For Rent' : 'For Sale'}</span>
                  </div>
                  <div class="detail-row">
                    <span><strong>Price:</strong></span>
                    <span>${listingTypeVal === 'rent' ? `$${dailyRateValue}/day` : `$${sellingPriceVal}`}</span>
                  </div>
                  <div class="detail-row">
                    <span><strong>Owner:</strong></span>
                    <span>${owner.first_name} ${owner.last_name}</span>
                  </div>
                  <div class="detail-row">
                    <span><strong>Owner Email:</strong></span>
                    <span>${owner.email}</span>
                  </div>
                </div>

                <p><strong>Please review and approve/reject this vehicle submission.</strong></p>
                
                <div style="text-align: center;">
                  <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/admin/vehicles/${newVehicle.id}" class="button">Review Vehicle</a>
                </div>
              </div>
              <div class="footer">
                <p>AutoFleet Hub Admin Dashboard</p>
                <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
              </div>
            </div>
          </body>
          </html>
        `;

        for (const email of adminEmails) {
          await emailService.sendEmail(email.trim(), subject, html);
        }

        console.log('✅ Vehicle submission notification sent to admin');
      } catch (emailError) {
        console.error('❌ Failed to send vehicle submission notification:', emailError);
      }

      successResponse(res, { vehicleId: newVehicle.id }, 'Vehicle submitted for approval successfully', 201);
    } catch (error) {
      console.error('Add vehicle error:', error);

      if (error.code === '23505') {
        return errorResponse(res, 'Vehicle with this license plate already exists', 409);
      }

      // Return more detailed error for debugging
      errorResponse(res, `Internal server error: ${error.message} (${error.code || 'no code'})`, 500);
    }
  }
);

// ADMIN: Approve/Reject vehicle (ENHANCED with email notifications)
router.put('/admin/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const vehicleId = req.params.id;
    const { status, rejectionReason } = req.body;

    if (!status || !['available', 'inactive', 'maintenance'].includes(status)) {
      return errorResponse(res, 'Valid status is required (available, inactive, maintenance)', 400);
    }

    // Get vehicle and owner details
    const vehicleResult = await pool.query(`
      SELECT v.*, u.first_name, u.last_name, u.email 
      FROM vehicles v
      LEFT JOIN users u ON v.owner_id = u.id
      WHERE v.id = $1
    `, [vehicleId]);

    const vehicle = vehicleResult.rows[0];
    if (!vehicle) {
      return errorResponse(res, 'Vehicle not found', 404);
    }

    // Update vehicle status
    await pool.query(
      'UPDATE vehicles SET status = $1, updated_at = NOW() WHERE id = $2',
      [status, vehicleId]
    );

    // 📧 SEND EMAIL NOTIFICATIONS
    try {
      const owner = {
        first_name: vehicle.first_name,
        last_name: vehicle.last_name,
        email: vehicle.email
      };

      if (status === 'available') {
        // Vehicle approved
        await emailService.sendVehicleApproved(vehicle, owner);
        console.log('✅ Vehicle approval email sent to owner');
      } else if (status === 'inactive' || status === 'maintenance') {
        // Vehicle rejected/needs updates
        const reason = rejectionReason || 'Your vehicle submission requires review. Please check the details and resubmit if necessary.';
        await emailService.sendVehicleRejected(vehicle, owner, reason);
        console.log('✅ Vehicle rejection email sent to owner');
      }
    } catch (emailError) {
      console.error('❌ Failed to send vehicle status email:', emailError);
    }

    const statusMessage = status === 'available' ? 'approved' :
      status === 'inactive' ? 'marked as pending' : 'marked as maintenance';

    successResponse(res, null, `Vehicle ${statusMessage} successfully`);
  } catch (err) {
    console.error('❌ Database error updating vehicle status:', err);
    errorResponse(res, 'Failed to update vehicle status', 500);
  }
});

// ADMIN: Bulk approve/reject vehicles (ENHANCED with email notifications)
router.put('/admin/bulk-status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { vehicleIds, status, rejectionReason } = req.body;

    if (!vehicleIds || !Array.isArray(vehicleIds) || vehicleIds.length === 0) {
      return errorResponse(res, 'Vehicle IDs array is required', 400);
    }

    if (!status || !['available', 'inactive', 'maintenance', 'rented'].includes(status)) {
      return errorResponse(res, 'Valid status is required (available, inactive, maintenance, rented)', 400);
    }

    console.log('📝 Bulk updating vehicles:', { vehicleIds, status });

    // Get vehicles and owners before update
    const vehiclesResult = await pool.query(`
      SELECT v.*, u.first_name, u.last_name, u.email 
      FROM vehicles v
      LEFT JOIN users u ON v.owner_id = u.id
      WHERE v.id = ANY($1)
    `, [vehicleIds]);

    const vehicles = vehiclesResult.rows;

    // Update vehicles
    const placeholders = vehicleIds.map((_, index) => `$${index + 1}`).join(',');
    const sql = `UPDATE vehicles SET status = $${vehicleIds.length + 1}, updated_at = NOW() WHERE id IN (${placeholders})`;
    const params = [...vehicleIds, status];

    const result = await pool.query(sql, params);

    // 📧 SEND BULK EMAIL NOTIFICATIONS
    try {
      const emailPromises = vehicles.map(async (vehicle) => {
        const owner = {
          first_name: vehicle.first_name,
          last_name: vehicle.last_name,
          email: vehicle.email
        };

        if (status === 'available') {
          return emailService.sendVehicleApproved(vehicle, owner);
        } else if (status === 'inactive' || status === 'maintenance') {
          const reason = rejectionReason || 'Your vehicle submission requires review. Please check the details and resubmit if necessary.';
          return emailService.sendVehicleRejected(vehicle, owner, reason);
        }
      });

      await Promise.allSettled(emailPromises);
      console.log('✅ Bulk email notifications sent to vehicle owners');
    } catch (emailError) {
      console.error('❌ Failed to send bulk email notifications:', emailError);
    }

    console.log('✅ Bulk update result:', result.rowCount, 'vehicles updated');

    successResponse(res, {
      updatedCount: result.rowCount,
      vehicleIds,
      status
    }, `${result.rowCount} vehicles updated successfully`);

  } catch (err) {
    console.error('❌ Database error in bulk vehicle update:', err);
    errorResponse(res, 'Failed to update vehicles', 500);
  }
});

// Update vehicle (ENHANCED with notifications for significant changes)
router.put('/:id', authenticateToken, requireOwnerOrAdmin, async (req, res) => {
  try {
    const vehicleId = req.params.id;
    const userId = req.user.id;
    const userRole = req.user.role;

    console.log('🔍 PUT /vehicles/:id DEBUG');
    console.log('  vehicleId:', vehicleId);
    console.log('  userId:', userId, 'type:', typeof userId);
    console.log('  userRole:', userRole);

    const vehicleResult = await pool.query(`
      SELECT v.*, u.first_name, u.last_name, u.email 
      FROM vehicles v
      LEFT JOIN users u ON v.owner_id = u.id
      WHERE v.id = $1
    `, [vehicleId]);
    const vehicle = vehicleResult.rows[0];

    console.log('  vehicle.owner_id:', vehicle?.owner_id, 'type:', typeof vehicle?.owner_id);

    if (!vehicle) {
      return errorResponse(res, 'Vehicle not found', 404);
    }

    if (userRole !== 'admin' && vehicle.owner_id !== userId) {
      // Try comparing as numbers in case of type mismatch
      const ownerIdNum = parseInt(vehicle.owner_id);
      const userIdNum = parseInt(userId);
      if (ownerIdNum !== userIdNum) {
        console.log('❌ Access denied - ownership check failed');
        console.log('  userRole !== admin:', userRole !== 'admin');
        console.log('  owner_id !== userId:', vehicle.owner_id, '!==', userId);
        console.log('  ownerIdNum !== userIdNum:', ownerIdNum, '!==', userIdNum);
        return errorResponse(res, 'Access denied', 403);
      }
    }

    console.log('✅ Ownership check passed');

    const {
      make, model, year, type, licensePlate, color, seats,
      transmission, fuelType, dailyRate, description, features,
      images, locationLat, locationLng, locationAddress, status
    } = req.body;

    let updateFields = [];
    let params = [];
    let idx = 1;
    let significantChange = false;

    // Track significant changes (price, status, availability)
    if (dailyRate && parseFloat(dailyRate) !== vehicle.daily_rate) {
      significantChange = true;
    }
    if (status && status !== vehicle.status) {
      significantChange = true;
    }

    // Build update query (existing logic)
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

    // 📧 SEND EMAIL NOTIFICATION FOR SIGNIFICANT CHANGES
    if (significantChange && userRole === 'admin') {
      try {
        const owner = {
          first_name: vehicle.first_name,
          last_name: vehicle.last_name,
          email: vehicle.email
        };

        const updatedVehicle = { ...vehicle, ...req.body };

        // Send update notification to owner
        const subject = `Vehicle Updated: ${vehicle.make} ${vehicle.model} - AutoFleet Hub`;
        const html = `
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; color: #333; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background: #17a2b8; color: white; padding: 20px; text-align: center; }
              .content { padding: 20px; background: #f9f9f9; }
              .vehicle-details { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; }
              .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>🔄 Vehicle Information Updated</h1>
              </div>
              <div class="content">
                <h2>Hello ${owner.first_name}!</h2>
                <p>Your vehicle information has been updated by our admin team.</p>
                
                <div class="vehicle-details">
                  <h3>🚗 Vehicle: ${vehicle.make} ${vehicle.model} ${vehicle.year}</h3>
                  <p><strong>License Plate:</strong> ${vehicle.license_plate}</p>
                  ${status ? `<p><strong>New Status:</strong> ${status.charAt(0).toUpperCase() + status.slice(1)}</p>` : ''}
                  ${dailyRate ? `<p><strong>New Daily Rate:</strong> $${dailyRate}</p>` : ''}
                </div>

                <p>If you have any questions about these changes, please contact our support team.</p>
              </div>
              <div class="footer">
                <p>If you have any questions, contact us at support@autofleet.com</p>
                <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
              </div>
            </div>
          </body>
          </html>
        `;

        await emailService.sendEmail(owner.email, subject, html);
        console.log('✅ Vehicle update notification sent to owner');
      } catch (emailError) {
        console.error('❌ Failed to send vehicle update notification:', emailError);
      }
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

// Delete vehicle (ENHANCED with email notifications)
router.delete('/:id', authenticateToken, requireOwnerOrAdmin, async (req, res) => {
  const vehicleId = req.params.id;
  const userId = req.user.id;
  const userRole = req.user.role;

  try {
    const vehicleResult = await pool.query(`
      SELECT v.*, u.first_name, u.last_name, u.email 
      FROM vehicles v
      LEFT JOIN users u ON v.owner_id = u.id
      WHERE v.id = $1
    `, [vehicleId]);
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

    // 📧 SEND DELETION NOTIFICATION EMAIL (if deleted by admin)
    if (userRole === 'admin' && vehicle.owner_id !== userId) {
      try {
        const owner = {
          first_name: vehicle.first_name,
          last_name: vehicle.last_name,
          email: vehicle.email
        };

        const subject = `Vehicle Removed: ${vehicle.make} ${vehicle.model} - AutoFleet Hub`;
        const html = `
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; color: #333; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background: #dc3545; color: white; padding: 20px; text-align: center; }
              .content { padding: 20px; background: #f9f9f9; }
              .vehicle-details { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; }
              .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>🚗 Vehicle Removed</h1>
              </div>
              <div class="content">
                <h2>Hello ${owner.first_name}!</h2>
                <p>Your vehicle has been removed from the AutoFleet Hub platform.</p>
                
                <div class="vehicle-details">
                  <h3>🚗 Removed Vehicle</h3>
                  <p><strong>Vehicle:</strong> ${vehicle.make} ${vehicle.model} ${vehicle.year}</p>
                  <p><strong>License Plate:</strong> ${vehicle.license_plate}</p>
                </div>

                <p>If you believe this was done in error or have questions, please contact our support team immediately.</p>
              </div>
              <div class="footer">
                <p>If you have any questions, contact us at support@autofleet.com</p>
                <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
              </div>
            </div>
          </body>
          </html>
        `;

        await emailService.sendEmail(owner.email, subject, html);
        console.log('✅ Vehicle deletion notification sent to owner');
      } catch (emailError) {
        console.error('❌ Failed to send vehicle deletion notification:', emailError);
      }
    }

    successResponse(res, null, 'Vehicle deleted successfully');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Failed to delete vehicle', 500);
  }
});


// ADD NEW ROUTE: Send vehicle status notification manually
router.post('/:id/notify', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const vehicleId = req.params.id;
    const { notificationType, customMessage } = req.body;

    // Get vehicle and owner details
    const vehicleResult = await pool.query(`
      SELECT v.*, u.first_name, u.last_name, u.email 
      FROM vehicles v
      LEFT JOIN users u ON v.owner_id = u.id
      WHERE v.id = $1
    `, [vehicleId]);

    const vehicle = vehicleResult.rows[0];
    if (!vehicle) {
      return errorResponse(res, 'Vehicle not found', 404);
    }

    const owner = {
      first_name: vehicle.first_name,
      last_name: vehicle.last_name,
      email: vehicle.email
    };

    let result;
    switch (notificationType) {
      case 'approved':
        result = await emailService.sendVehicleApproved(vehicle, owner);
        break;
      case 'rejected':
        result = await emailService.sendVehicleRejected(vehicle, owner, customMessage || 'Please review your vehicle submission.');
        break;
      default:
        return errorResponse(res, 'Invalid notification type', 400);
    }

    if (result.success) {
      successResponse(res, { messageId: result.messageId }, 'Notification email sent successfully');
    } else {
      errorResponse(res, `Failed to send notification: ${result.error}`, 500);
    }
  } catch (err) {
    console.error('❌ Error sending vehicle notification:', err);
    errorResponse(res, 'Failed to send notification', 500);
  }
});

// ADD NEW ROUTE: Test vehicle email notifications
router.post('/test-email', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { emailType = 'approved', email } = req.body;

    if (!email) {
      return errorResponse(res, 'Email address is required', 400);
    }

    const testVehicle = {
      id: 'TEST-123',
      make: 'Toyota',
      model: 'Camry',
      year: 2022,
      license_plate: 'TEST-123',
      type: 'sedan',
      daily_rate: 50
    };

    const testOwner = {
      first_name: 'Test',
      last_name: 'Owner',
      email: email
    };

    let result;
    switch (emailType) {
      case 'approved':
        result = await emailService.sendVehicleApproved(testVehicle, testOwner);
        break;
      case 'rejected':
        result = await emailService.sendVehicleRejected(testVehicle, testOwner, 'This is a test rejection reason.');
        break;
      default:
        result = await emailService.sendEmail(email, 'Test Email - Vehicle Service', '<h1>Test Email</h1><p>Vehicle email service is working correctly!</p>');
    }

    if (result.success) {
      successResponse(res, { messageId: result.messageId }, 'Test email sent successfully');
    } else {
      errorResponse(res, `Failed to send test email: ${result.error}`, 500);
    }
  } catch (err) {
    console.error('❌ Error sending test email:', err);
    errorResponse(res, 'Failed to send test email', 500);
  }
});

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