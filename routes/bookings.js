const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/helpers');
const EmailService = require('../Service/EmailService');
const axios = require('axios');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_API_URL = 'https://api.paystack.co';

// Create an instance of EmailService
const emailService = new EmailService();

// Get active bookings (confirmed and ongoing)
router.get('/active', authenticateToken, async (req, res) => {
  const requestingUserId = req.user.id;
  const requestingUserRole = req.user.role;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  try {
    let sql = `
      SELECT b.*, 
             v.make, v.model, v.year, v.license_plate, v.type, v.color, v.images,
             v.owner_id, v.location_address,
             u.first_name as customer_first_name, u.last_name as customer_last_name, 
             u.email as customer_email, u.phone as customer_phone
      FROM bookings b
      LEFT JOIN vehicles v ON b.vehicle_id = v.id
      LEFT JOIN users u ON b.customer_id = u.id
      WHERE b.status = 'confirmed'
        AND b.start_date <= $1
        AND b.end_date >= $1
    `;
    let params = [today];

    // Role-based filtering
    if (requestingUserRole === 'customer') {
      sql += ' AND b.customer_id = $2';
      params.push(requestingUserId);
    } else if (requestingUserRole === 'owner') {
      sql += ' AND v.owner_id = $2';
      params.push(requestingUserId);
    }

    sql += ' ORDER BY b.start_date ASC';

    const { rows: bookings } = await pool.query(sql, params);

    bookings.forEach(booking => {
      if (booking.images && typeof booking.images === 'string') {
        try {
          booking.images = JSON.parse(booking.images);
        } catch (e) {
          booking.images = [];
        }
      }
      // Calculate duration_days
      if (booking.start_date && booking.end_date) {
        const start = new Date(booking.start_date);
        const end = new Date(booking.end_date);
        const diff = Math.round((end - start) / (1000 * 60 * 60 * 24));
        booking.duration_days = diff;
      } else {
        booking.duration_days = undefined;
      }
    });

    successResponse(res, { bookings }, 'Active bookings retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Failed to retrieve active bookings', 500);
  }
});

// ADMIN: Get all bookings with advanced filtering and search
router.get('/admin/all', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      search,
      dateRange,
      payment_status,
      sortBy = 'created_at',
      sortOrder = 'DESC'
    } = req.query;

    const offset = (page - 1) * limit;
    console.log('=== ADMIN BOOKINGS QUERY ===');
    console.log('Filters:', { status, search, dateRange, payment_status, sortBy, sortOrder });

    // Build main query
    let sql = `
      SELECT 
        b.id,
        b.customer_id,
        b.vehicle_id,
        b.start_date,
        b.end_date,
        b.total_amount,
        b.status,
        b.payment_status,
        b.payment_method,
        b.pickup_location,
        b.created_at,
        b.updated_at,
        -- Customer info
        CONCAT(u.first_name, ' ', u.last_name) as customer_name,
        u.email as customer_email,
        u.phone as customer_phone,
        -- Vehicle info
        CONCAT(v.make, ' ', v.model, ' ', v.year) as vehicle_name,
        v.license_plate,
        v.type as vehicle_type,
        v.images as vehicle_images,
        -- Owner info
        CONCAT(o.first_name, ' ', o.last_name) as owner_name,
        o.email as owner_email,
        o.phone as owner_phone
      FROM bookings b
      LEFT JOIN users u ON b.customer_id = u.id
      LEFT JOIN vehicles v ON b.vehicle_id = v.id
      LEFT JOIN users o ON v.owner_id = o.id
      WHERE 1=1
    `;

    let params = [];
    let paramCount = 0;

    // Status filter
    if (status && status !== 'all') {
      paramCount++;
      sql += ` AND b.status = $${paramCount}`;
      params.push(status);
    }

    // Payment status filter
    if (payment_status && payment_status !== 'all') {
      paramCount++;
      sql += ` AND b.payment_status = $${paramCount}`;
      params.push(payment_status);
    }

    // Search filter (customer name, email, vehicle, plate)
    if (search && search.trim()) {
      paramCount++;
      sql += ` AND (
        LOWER(CONCAT(u.first_name, ' ', u.last_name)) LIKE LOWER($${paramCount}) OR
        LOWER(u.email) LIKE LOWER($${paramCount}) OR
        LOWER(CONCAT(v.make, ' ', v.model)) LIKE LOWER($${paramCount}) OR
        LOWER(v.license_plate) LIKE LOWER($${paramCount}) OR
        LOWER(CONCAT(o.first_name, ' ', o.last_name)) LIKE LOWER($${paramCount})
      )`;
      params.push(`%${search.trim()}%`);
    }

    // Date range filter
    if (dateRange) {
      const now = new Date();
      let startDate;

      switch (dateRange) {
        case 'today':
          startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          break;
        case 'week':
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case 'month':
          startDate = new Date(now.getFullYear(), now.getMonth(), 1);
          break;
        case 'quarter':
          startDate = new Date(now.getFullYear(), now.getMonth() - 3, 1);
          break;
          desNfault:
          startDate = null;
      }

      if (startDate) {
        paramCount++;
        sql += ` AND b.created_at >= $${paramCount}`;
        params.push(startDate.toISOString());
      }
    }

    // Sorting
    const allowedSortFields = ['created_at', 'start_date', 'end_date', 'total_amount', 'status'];
    const validSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'created_at';
    const validSortOrder = ['ASC', 'DESC'].includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';

    sql += ` ORDER BY b.${validSortBy} ${validSortOrder}`;

    // Pagination
    sql += ` LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    // Execute main query
    const result = await pool.query(sql, params);
    const bookings = result.rows.map(booking => {
      // Calculate duration
      if (booking.start_date && booking.end_date) {
        const start = new Date(booking.start_date);
        const end = new Date(booking.end_date);
        const diff = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
        booking.duration_days = diff;
      }

      // Parse vehicle images
      if (booking.vehicle_images && typeof booking.vehicle_images === 'string') {
        try {
          booking.vehicle_images = JSON.parse(booking.vehicle_images);
        } catch (e) {
          booking.vehicle_images = [];
        }
      }

      // Format dates for display
      booking.date_range = booking.start_date && booking.end_date
        ? `${new Date(booking.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} → ${new Date(booking.end_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
        : 'N/A';

      return booking;
    });

    // Get total count for pagination (same filters)
    let countSql = `
      SELECT COUNT(*) as total
      FROM bookings b
      LEFT JOIN users u ON b.customer_id = u.id
      LEFT JOIN vehicles v ON b.vehicle_id = v.id
      LEFT JOIN users o ON v.owner_id = o.id
      WHERE 1=1
    `;
    let countParams = [];
    let countParamCount = 0;

    // Apply same filters for count
    if (status && status !== 'all') {
      countParamCount++;
      countSql += ` AND b.status = $${countParamCount}`;
      countParams.push(status);
    }

    if (payment_status && payment_status !== 'all') {
      countParamCount++;
      countSql += ` AND b.payment_status = $${countParamCount}`;
      countParams.push(payment_status);
    }

    if (search && search.trim()) {
      countParamCount++;
      countSql += ` AND (
        LOWER(CONCAT(u.first_name, ' ', u.last_name)) LIKE LOWER($${countParamCount}) OR
        LOWER(u.email) LIKE LOWER($${countParamCount}) OR
        LOWER(CONCAT(v.make, ' ', v.model)) LIKE LOWER($${countParamCount}) OR
        LOWER(v.license_plate) LIKE LOWER($${countParamCount}) OR
        LOWER(CONCAT(o.first_name, ' ', o.last_name)) LIKE LOWER($${countParamCount})
      )`;
      countParams.push(`%${search.trim()}%`);
    }

    if (dateRange) {
      const now = new Date();
      let startDate;

      switch (dateRange) {
        case 'today':
          startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          break;
        case 'week':
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case 'month':
          startDate = new Date(now.getFullYear(), now.getMonth(), 1);
          break;
        case 'quarter':
          startDate = new Date(now.getFullYear(), now.getMonth() - 3, 1);
          break;
        default:
          startDate = null;
      }

      if (startDate) {
        countParamCount++;
        countSql += ` AND b.created_at >= $${countParamCount}`;
        countParams.push(startDate.toISOString());
      }
    }

    const countResult = await pool.query(countSql, countParams);
    const total = parseInt(countResult.rows[0].total);

    console.log('📊 Admin bookings result:', {
      totalFound: total,
      currentPage: bookings.length,
      filters: { status, search, dateRange, payment_status }
    });

    successResponse(res, {
      bookings,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit),
        hasNext: page * limit < total,
        hasPrev: page > 1
      },
      filters: {
        status,
        search,
        dateRange,
        payment_status,
        sortBy: validSortBy,
        sortOrder: validSortOrder
      }
    }, 'Admin bookings retrieved successfully');

  } catch (err) {
    console.error('❌ Database error in admin bookings:', err);
    errorResponse(res, 'Failed to retrieve admin bookings', 500);
  }
});

// ADMIN: Get booking statistics by category
router.get('/admin/stats/categories', authenticateToken, requireAdmin, async (req, res) => {
  try {
    console.log('🔍 Getting booking category statistics...');

    const categoriesQuery = `
      SELECT 
        -- All bookings
        COUNT(*) as all_bookings,
        
        -- Pending approval
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_approval,
        
        -- Completed rentals
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_rentals,
        
        -- Canceled/Disputed
        COUNT(CASE WHEN status IN ('cancelled', 'disputed') THEN 1 END) as canceled_disputed
        
      FROM bookings
    `;

    const result = await pool.query(categoriesQuery);
    const stats = result.rows[0];

    const categories = {
      all_bookings: parseInt(stats.all_bookings || 0),
      pending_approval: parseInt(stats.pending_approval || 0),
      completed_rentals: parseInt(stats.completed_rentals || 0),
      canceled_disputed: parseInt(stats.canceled_disputed || 0)
    };

    console.log('📊 Booking categories:', categories);

    successResponse(res, categories, 'Booking categories retrieved successfully');
  } catch (err) {
    console.error('❌ Database error in booking categories:', err);
    errorResponse(res, 'Failed to retrieve booking categories', 500);
  }
});

// ADMIN: Bulk update booking status
router.put('/admin/bulk-status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { bookingIds, status } = req.body;

    if (!bookingIds || !Array.isArray(bookingIds) || bookingIds.length === 0) {
      return errorResponse(res, 'Booking IDs array is required', 400);
    }

    if (!status || !['pending', 'confirmed', 'active', 'completed', 'cancelled', 'disputed'].includes(status)) {
      return errorResponse(res, 'Valid status is required', 400);
    }

    console.log('📝 Bulk updating bookings:', { bookingIds, status });

    const placeholders = bookingIds.map((_, index) => `$${index + 1}`).join(',');
    const sql = `
      UPDATE bookings 
      SET status = $${bookingIds.length + 1}, updated_at = CURRENT_TIMESTAMP 
      WHERE id IN (${placeholders})
    `;
    const params = [...bookingIds, status];

    const result = await pool.query(sql, params);

    console.log('✅ Bulk update result:', result.rowCount, 'bookings updated');

    successResponse(res, {
      updatedCount: result.rowCount,
      bookingIds,
      newStatus: status
    }, `${result.rowCount} bookings updated successfully`);

  } catch (err) {
    console.error('❌ Database error in bulk status update:', err);
    errorResponse(res, 'Failed to update booking statuses', 500);
  }
});

// ADMIN: Export bookings data
router.get('/admin/export', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const {
      status,
      dateRange,
      format = 'json' // json or csv
    } = req.query;

    console.log('📤 Exporting bookings:', { status, dateRange, format });

    let sql = `
      SELECT 
        b.id as booking_id,
        CONCAT(u.first_name, ' ', u.last_name) as customer_name,
        u.email as customer_email,
        CONCAT(v.make, ' ', v.model, ' ', v.year) as vehicle,
        v.license_plate,
        CONCAT(o.first_name, ' ', o.last_name) as owner_name,
        b.status,
        b.start_date,
        b.end_date,
        b.total_amount,
        b.payment_status,
        b.payment_method,
        b.created_at
      FROM bookings b
      LEFT JOIN users u ON b.customer_id = u.id
      LEFT JOIN vehicles v ON b.vehicle_id = v.id
      LEFT JOIN users o ON v.owner_id = o.id
      WHERE 1=1
    `;

    let params = [];
    let paramCount = 0;

    // Apply filters
    if (status && status !== 'all') {
      paramCount++;
      sql += ` AND b.status = $${paramCount}`;
      params.push(status);
    }

    if (dateRange) {
      const now = new Date();
      let startDate;

      switch (dateRange) {
        case 'month':
          startDate = new Date(now.getFullYear(), now.getMonth(), 1);
          break;
        case 'quarter':
          startDate = new Date(now.getFullYear(), now.getMonth() - 3, 1);
          break;
        case 'year':
          startDate = new Date(now.getFullYear(), 0, 1);
          break;
        default:
          startDate = null;
      }

      if (startDate) {
        paramCount++;
        sql += ` AND b.created_at >= $${paramCount}`;
        params.push(startDate.toISOString());
      }
    }

    sql += ` ORDER BY b.created_at DESC`;

    const result = await pool.query(sql, params);
    const bookings = result.rows;

    console.log('📊 Export data:', bookings.length, 'bookings');

    if (format === 'csv') {
      // Convert to CSV format
      const csvHeaders = [
        'Booking ID', 'Customer', 'Email', 'Vehicle', 'Plate', 'Owner',
        'Status', 'Start Date', 'End Date', 'Amount', 'Payment Status', 'Payment Method', 'Created At'
      ].join(',');

      const csvRows = bookings.map(b => [
        b.booking_id,
        `"${b.customer_name || ''}"`,
        `"${b.customer_email || ''}"`,
        `"${b.vehicle || ''}"`,
        `"${b.license_plate || ''}"`,
        `"${b.owner_name || ''}"`,
        b.status,
        b.start_date ? new Date(b.start_date).toISOString().split('T')[0] : '',
        b.end_date ? new Date(b.end_date).toISOString().split('T')[0] : '',
        b.total_amount || 0,
        b.payment_status,
        b.payment_method || '',
        b.created_at ? new Date(b.created_at).toISOString() : ''
      ].join(','));

      const csvContent = [csvHeaders, ...csvRows].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="bookings-export-${Date.now()}.csv"`);
      res.send(csvContent);
    } else {
      // Return JSON format
      successResponse(res, {
        bookings,
        exportInfo: {
          totalRecords: bookings.length,
          filters: { status, dateRange },
          exportDate: new Date().toISOString(),
          format
        }
      }, 'Bookings exported successfully');
    }

  } catch (err) {
    console.error('❌ Database error in bookings export:', err);
    errorResponse(res, 'Failed to export bookings', 500);
  }
});

// ADMIN: Get booking details for management
router.get('/admin/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const bookingId = req.params.id;
    console.log('🔍 Getting admin booking details for ID:', bookingId);

    const sql = `
      SELECT 
        b.*,
        -- Customer details
        u.first_name as customer_first_name,
        u.last_name as customer_last_name,
        u.email as customer_email,
        u.phone as customer_phone,
        -- Vehicle details
        v.make, v.model, v.year, v.license_plate, v.type, v.color, v.images,
        v.daily_rate, v.selling_price, v.listing_type,
        -- Owner details
        o.first_name as owner_first_name,
        o.last_name as owner_last_name,
        o.email as owner_email,
        o.phone as owner_phone
      FROM bookings b
      LEFT JOIN users u ON b.customer_id = u.id
      LEFT JOIN vehicles v ON b.vehicle_id = v.id
      LEFT JOIN users o ON v.owner_id = o.id
      WHERE b.id = $1
    `;

    const result = await pool.query(sql, [bookingId]);
    const booking = result.rows[0];

    if (!booking) {
      return errorResponse(res, 'Booking not found', 404);
    }

    // Parse vehicle images
    if (booking.images && typeof booking.images === 'string') {
      try {
        booking.images = JSON.parse(booking.images);
      } catch (e) {
        booking.images = [];
      }
    }

    // Calculate duration
    if (booking.start_date && booking.end_date) {
      const start = new Date(booking.start_date);
      const end = new Date(booking.end_date);
      const diff = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
      booking.duration_days = diff;
    }

    console.log('✅ Admin booking details retrieved for:', booking.id);

    successResponse(res, booking, 'Admin booking details retrieved successfully');
  } catch (err) {
    console.error('❌ Database error in admin booking details:', err);
    errorResponse(res, 'Failed to retrieve booking details', 500);
  }
});

// Get all bookings with filtering (existing route)
router.get('/', authenticateToken, async (req, res) => {
  const {
    page = 1,
    limit = 10,
    status,
    customerId,
    vehicleId,
    startDate,
    endDate
  } = req.query;

  const offset = (page - 1) * limit;
  const requestingUserId = req.user.id;
  const requestingUserRole = req.user.role;

  try {
    // Build query
    let sql = `
      SELECT b.*, 
             v.make, v.model, v.year, v.license_plate, v.type, v.color, v.images,
             v.owner_id, v.location_address,
             u.first_name as customer_first_name, u.last_name as customer_last_name, 
             u.email as customer_email, u.phone as customer_phone
      FROM bookings b
      LEFT JOIN vehicles v ON b.vehicle_id = v.id
      LEFT JOIN users u ON b.customer_id = u.id
      WHERE 1=1
    `;
    let params = [];
    let paramCount = 0;

    // Role-based filtering
    if (requestingUserRole === 'customer') {
      paramCount++;
      sql += ` AND b.customer_id = $${paramCount}`;
      params.push(requestingUserId);
    } else if (requestingUserRole === 'owner') {
      paramCount++;
      sql += ` AND v.owner_id = $${paramCount}`;
      params.push(requestingUserId);
    }
    // Admin sees all bookings (no additional filter)

    // Additional filters
    if (status) {
      paramCount++;
      sql += ` AND b.status = $${paramCount}`;
      params.push(status);
    }

    if (customerId && requestingUserRole === 'admin') {
      paramCount++;
      sql += ` AND b.customer_id = $${paramCount}`;
      params.push(customerId);
    }

    if (vehicleId) {
      paramCount++;
      sql += ` AND b.vehicle_id = $${paramCount}`;
      params.push(vehicleId);
    }

    if (startDate) {
      paramCount++;
      sql += ` AND b.start_date >= $${paramCount}`;
      params.push(startDate);
    }

    if (endDate) {
      paramCount++;
      sql += ` AND b.end_date <= $${paramCount}`;
      params.push(endDate);
    }

    // Add ordering and pagination
    sql += ` ORDER BY b.created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    params.push(limit, offset);

    // Execute query
    const { rows: bookings } = await pool.query(sql, params);

    // Parse images if available and calculate duration_days
    bookings.forEach(booking => {
      if (booking.images && typeof booking.images === 'string') {
        try {
          booking.images = JSON.parse(booking.images);
        } catch (e) {
          booking.images = [];
        }
      }
      // Calculate duration_days
      if (booking.start_date && booking.end_date) {
        const start = new Date(booking.start_date);
        const end = new Date(booking.end_date);
        const diff = Math.round((end - start) / (1000 * 60 * 60 * 24));
        booking.duration_days = diff;
      } else {
        booking.duration_days = undefined;
      }
    });

    // Get total count
    let countSql = `
      SELECT COUNT(*) as total 
      FROM bookings b
      LEFT JOIN vehicles v ON b.vehicle_id = v.id
      WHERE 1=1
    `;
    let countParams = [];
    let countParamCount = 0;

    // Apply same filters for count
    if (requestingUserRole === 'customer') {
      countParamCount++;
      countSql += ` AND b.customer_id = $${countParamCount}`;
      countParams.push(requestingUserId);
    } else if (requestingUserRole === 'owner') {
      countParamCount++;
      countSql += ` AND v.owner_id = $${countParamCount}`;
      countParams.push(requestingUserId);
    }

    if (status) {
      countParamCount++;
      countSql += ` AND b.status = $${countParamCount}`;
      countParams.push(status);
    }

    if (customerId && requestingUserRole === 'admin') {
      countParamCount++;
      countSql += ` AND b.customer_id = $${countParamCount}`;
      countParams.push(customerId);
    }

    if (vehicleId) {
      countParamCount++;
      countSql += ` AND b.vehicle_id = $${countParamCount}`;
      countParams.push(vehicleId);
    }

    if (startDate) {
      countParamCount++;
      countSql += ` AND b.start_date >= $${countParamCount}`;
      countParams.push(startDate);
    }

    if (endDate) {
      countParamCount++;
      countSql += ` AND b.end_date <= $${countParamCount}`;
      countParams.push(endDate);
    }

    const { rows: countResult } = await pool.query(countSql, countParams);
    const total = parseInt(countResult[0].total);

    successResponse(res, {
      bookings,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      }
    }, 'Bookings retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Database error', 500);
  }
});

// Get booking by ID (existing route)
router.get('/:id', authenticateToken, async (req, res) => {
  const bookingId = req.params.id;
  const requestingUserId = req.user.id;
  const requestingUserRole = req.user.role;

  try {
    const { rows } = await pool.query(`
      SELECT b.*, 
             v.make, v.model, v.year, v.license_plate, v.type, v.color, v.images,
             v.owner_id, v.location_address,
             u.first_name as customer_first_name, u.last_name as customer_last_name, 
             u.email as customer_email, u.phone as customer_phone,
             o.first_name as owner_first_name, o.last_name as owner_last_name,
             o.email as owner_email, o.phone as owner_phone
      FROM bookings b
      LEFT JOIN vehicles v ON b.vehicle_id = v.id
      LEFT JOIN users u ON b.customer_id = u.id
      LEFT JOIN users o ON v.owner_id = o.id
      WHERE b.id = $1
    `, [bookingId]);

    const booking = rows[0];

    if (!booking) {
      return errorResponse(res, 'Booking not found', 404);
    }

    // Check access permissions
    const hasAccess = requestingUserRole === 'admin' ||
      booking.customer_id === requestingUserId ||
      booking.owner_id === requestingUserId;

    if (!hasAccess) {
      return errorResponse(res, 'Access denied', 403);
    }

    // Parse images if available
    if (booking.images && typeof booking.images === 'string') {
      try {
        booking.images = JSON.parse(booking.images);
      } catch (e) {
        booking.images = [];
      }
    }

    successResponse(res, booking, 'Booking retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Database error', 500);
  }
});

// Get booking statistics (existing route)
router.get('/stats/overview', authenticateToken, async (req, res) => {
  const requestingUserId = req.user.id;
  const requestingUserRole = req.user.role;

  let baseCondition = '';
  let params = [];
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  if (requestingUserRole === 'customer') {
    baseCondition = 'WHERE customer_id = $1';
    params = [requestingUserId];
  } else if (requestingUserRole === 'owner') {
    baseCondition = 'WHERE vehicle_id IN (SELECT id FROM vehicles WHERE owner_id = $1)';
    params = [requestingUserId];
  }

  const queries = [
    `SELECT COUNT(*) as total FROM bookings ${baseCondition}`,
    `SELECT COUNT(*) as pending FROM bookings ${baseCondition} ${baseCondition ? 'AND' : 'WHERE'} status = 'pending'`,
    `SELECT COUNT(*) as confirmed FROM bookings ${baseCondition} ${baseCondition ? 'AND' : 'WHERE'} status = 'confirmed'`,
    // Active: confirmed and ongoing
    `SELECT COUNT(*) as active FROM bookings ${baseCondition} ${baseCondition ? 'AND' : 'WHERE'} status = 'confirmed' AND start_date <= $${params.length + 1} AND end_date >= $${params.length + 1}`,
    `SELECT COUNT(*) as completed FROM bookings ${baseCondition} ${baseCondition ? 'AND' : 'WHERE'} status = 'completed'`,
    `SELECT SUM(total_amount) as totalRevenue FROM bookings ${baseCondition} ${baseCondition ? 'AND' : 'WHERE'} payment_status = 'paid'`
  ];
  const statsParams = [...params, today];

  try {
    const results = await Promise.all([
      pool.query(queries[0], params),
      pool.query(queries[1], params),
      pool.query(queries[2], params),
      pool.query(queries[3], statsParams), // active uses today param
      pool.query(queries[4], params),
      pool.query(queries[5], params),
    ]);
    const stats = {
      totalBookings: parseInt(results[0].rows[0]?.total) || 0,
      pendingBookings: parseInt(results[1].rows[0]?.pending) || 0,
      confirmedBookings: parseInt(results[2].rows[0]?.confirmed) || 0,
      activeBookings: parseInt(results[3].rows[0]?.active) || 0,
      completedBookings: parseInt(results[4].rows[0]?.completed) || 0,
      totalRevenue: parseFloat(results[5].rows[0]?.totalrevenue) || 0
    };
    successResponse(res, stats, 'Booking statistics retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Failed to retrieve booking statistics', 500);
  }
});

// Update booking status (existing route)
router.put('/:id/status', authenticateToken, async (req, res) => {
  const bookingId = req.params.id;
  const { status } = req.body;
  const requestingUserId = req.user.id;
  const requestingUserRole = req.user.role;

  if (!status || !['pending', 'confirmed', 'active', 'completed', 'cancelled'].includes(status)) {
    return errorResponse(res, 'Valid status is required', 400);
  }

  try {
    // Get booking details with complete info
    const { rows } = await pool.query(`
      SELECT b.*, v.owner_id,
             v.make, v.model, v.year, v.license_plate,
             u.first_name as customer_first_name, u.last_name as customer_last_name, 
             u.email as customer_email,
             o.first_name as owner_first_name, o.last_name as owner_last_name,
             o.email as owner_email
      FROM bookings b
      LEFT JOIN vehicles v ON b.vehicle_id = v.id
      LEFT JOIN users u ON b.customer_id = u.id
      LEFT JOIN users o ON v.owner_id = o.id
      WHERE b.id = $1
    `, [bookingId]);

    const booking = rows[0];

    if (!booking) {
      return errorResponse(res, 'Booking not found', 404);
    }

    const oldStatus = booking.status;

    // Check permissions
    let canUpdate = false;
    if (requestingUserRole === 'admin') {
      canUpdate = true;
    } else if (requestingUserRole === 'owner' && booking.owner_id === requestingUserId) {
      canUpdate = ['confirmed', 'cancelled'].includes(status);
    } else if (requestingUserRole === 'customer' && booking.customer_id === requestingUserId) {
      canUpdate = status === 'cancelled' && ['pending', 'confirmed'].includes(booking.status);
    }

    if (!canUpdate) {
      return errorResponse(res, 'Access denied or invalid status transition', 403);
    }

    // Update booking status
    await pool.query(`
      UPDATE bookings 
      SET status = $1, updated_at = CURRENT_TIMESTAMP 
      WHERE id = $2
    `, [status, bookingId]);

    // Update vehicle status if needed
    if (status === 'active') {
      await pool.query('UPDATE vehicles SET status = $1 WHERE id = $2', ['rented', booking.vehicle_id]);
    } else if (status === 'completed') {
      // If it's a sale and it's completed, it's Soldout (inactive)
      const newStatus = booking.listing_type === 'sale' ? 'inactive' : 'available';
      await pool.query('UPDATE vehicles SET status = $1 WHERE id = $2', [newStatus, booking.vehicle_id]);
    } else if (status === 'cancelled') {
      await pool.query('UPDATE vehicles SET status = $1 WHERE id = $2', ['available', booking.vehicle_id]);
    }

    // 📧 SEND STATUS UPDATE EMAIL NOTIFICATIONS
    try {
      const customer = {
        first_name: booking.customer_first_name,
        last_name: booking.customer_last_name,
        email: booking.customer_email
      };

      const owner = {
        first_name: booking.owner_first_name,
        last_name: booking.owner_last_name,
        email: booking.owner_email
      };

      const vehicle = {
        make: booking.make,
        model: booking.model,
        year: booking.year,
        license_plate: booking.license_plate
      };

      const bookingData = {
        id: booking.id,
        start_date: booking.start_date,
        end_date: booking.end_date,
        total_amount: booking.total_amount,
        pickup_location: booking.pickup_location,
        old_status: oldStatus,
        new_status: status
      };

      // Send status update to customer
      await emailService.sendBookingStatusUpdate(bookingData, customer, status, oldStatus);
      console.log('✅ Booking status update sent to customer:', customer.email);

      // Send status update to owner if different from customer
      if (booking.owner_id !== booking.customer_id) {
        await emailService.sendBookingStatusUpdateToOwner(bookingData, owner, customer, vehicle, status, oldStatus);
        console.log('✅ Booking status update sent to owner:', owner.email);
      }

      // Send admin notification for important status changes
      if (['cancelled', 'completed'].includes(status)) {
        const adminEmails = process.env.ADMIN_EMAILS ? process.env.ADMIN_EMAILS.split(',') : ['admin@autofleet.com'];
        for (const email of adminEmails) {
          await emailService.sendBookingStatusAdminNotification(email.trim(), bookingData, customer, vehicle, status, oldStatus);
        }
        console.log('✅ Booking status admin notifications sent');
      }

    } catch (emailError) {
      console.error('❌ Failed to send booking status update email notifications:', emailError);
      // Don't fail the status update if email fails
    }

    successResponse(res, null, 'Booking status updated successfully');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Failed to update booking status', 500);
  }
});

// Process payment for booking (existing route)
router.post('/:id/payment', authenticateToken, async (req, res) => {
  const bookingId = req.params.id;
  const { paymentMethod, transactionId } = req.body;
  const requestingUserId = req.user.id;

  if (!paymentMethod) {
    return errorResponse(res, 'Payment method is required', 400);
  }

  try {
    // Get booking details with complete info
    const { rows } = await pool.query(`
      SELECT b.*, 
             v.make, v.model, v.year, v.license_plate,
             u.first_name as customer_first_name, u.last_name as customer_last_name, 
             u.email as customer_email,
             o.first_name as owner_first_name, o.last_name as owner_last_name,
             o.email as owner_email
      FROM bookings b
      LEFT JOIN vehicles v ON b.vehicle_id = v.id
      LEFT JOIN users u ON b.customer_id = u.id
      LEFT JOIN users o ON v.owner_id = o.id
      WHERE b.id = $1 AND b.customer_id = $2
    `, [bookingId, requestingUserId]);

    const booking = rows[0];

    if (!booking) {
      return errorResponse(res, 'Booking not found or access denied', 404);
    }

    if (booking.payment_status === 'paid') {
      return errorResponse(res, 'Payment already processed', 400);
    }

    // Update payment information
    await pool.query(`
      UPDATE bookings 
      SET payment_status = 'paid', 
          payment_method = $1, 
          payment_transaction_id = $2, 
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
    `, [paymentMethod, transactionId, bookingId]);

    // 📧 SEND PAYMENT CONFIRMATION EMAIL
    try {
      const customer = {
        first_name: booking.customer_first_name,
        last_name: booking.customer_last_name,
        email: booking.customer_email
      };

      const owner = {
        first_name: booking.owner_first_name,
        last_name: booking.owner_last_name,
        email: booking.owner_email
      };

      const vehicle = {
        make: booking.make,
        model: booking.model,
        year: booking.year,
        license_plate: booking.license_plate
      };

      const bookingData = {
        id: booking.id,
        start_date: booking.start_date,
        end_date: booking.end_date,
        total_amount: booking.total_amount,
        pickup_location: booking.pickup_location,
        payment_method: paymentMethod,
        payment_transaction_id: transactionId
      };

      // Send payment confirmation to customer
      await emailService.sendPaymentConfirmation(bookingData, customer, vehicle);
      console.log('✅ Payment confirmation sent to customer:', customer.email);

      // Send payment notification to owner
      await emailService.sendPaymentNotificationToOwner(bookingData, owner, customer, vehicle);
      console.log('✅ Payment notification sent to owner:', owner.email);

    } catch (emailError) {
      console.error('❌ Failed to send payment confirmation email:', emailError);
      // Don't fail the payment processing if email fails
    }

    successResponse(res, null, 'Payment processed successfully');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Failed to process payment', 500);
  }
});

// Cancel booking (existing route)
router.delete('/:id', authenticateToken, async (req, res) => {
  const bookingId = req.params.id;
  const requestingUserId = req.user.id;
  const requestingUserRole = req.user.role;

  try {
    // Get booking details
    const { rows } = await pool.query(`
      SELECT b.*, v.owner_id 
      FROM bookings b
      LEFT JOIN vehicles v ON b.vehicle_id = v.id
      WHERE b.id = $1
    `, [bookingId]);

    const booking = rows[0];

    if (!booking) {
      return errorResponse(res, 'Booking not found', 404);
    }

    // Only allow cancel if status is pending or confirmed
    if (!['pending', 'confirmed'].includes(booking.status)) {
      return errorResponse(res, 'Cannot cancel booking in current status', 400);
    }

    // Permission: admin, customer (own), or owner (own vehicle)
    const canCancel =
      requestingUserRole === 'admin' ||
      booking.customer_id === requestingUserId ||
      booking.owner_id === requestingUserId;

    if (!canCancel) {
      return errorResponse(res, 'Access denied', 403);
    }

    // Update booking status to cancelled
    await pool.query(
      `UPDATE bookings SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [bookingId]
    );

    // Set vehicle status to available if booking was confirmed
    if (booking.status === 'confirmed') {
      await pool.query(
        'UPDATE vehicles SET status = $1 WHERE id = $2',
        ['available', booking.vehicle_id]
      );
    }

    successResponse(res, null, 'Booking cancelled successfully');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Failed to cancel booking', 500);
  }
});

// Create a new booking (existing route)
router.post('/', authenticateToken, async (req, res) => {
  const {
    vehicle_id,
    pickup_location,
    pickup_date,
    return_date,
    payment_method,
    total_price,
    telephone,
    flw_transaction_id
  } = req.body;

  const customer_id = req.user.id;

  // Validation (dates optional for now, will validate after fetching vehicle)
  if (!vehicle_id || !pickup_location || !payment_method) {
    return errorResponse(res, 'Missing required fields: vehicle_id, pickup_location, payment_method', 400);
  }

  // Validate payment method
  if (!['mobile', 'card'].includes(payment_method)) {
    return errorResponse(res, 'Invalid payment method. Must be "mobile" or "card"', 400);
  }

  // Validate payment details based on method
  if (payment_method === 'mobile' && !telephone) {
    return errorResponse(res, 'Telephone number is required for mobile payment', 400);
  }

  try {
    // Check if vehicle exists and is available
    const vehicleResult = await pool.query(
      'SELECT * FROM vehicles WHERE id = $1',
      [vehicle_id]
    );

    if (vehicleResult.rows.length === 0) {
      return errorResponse(res, 'Vehicle not found', 404);
    }

    const vehicle = vehicleResult.rows[0];
    const isSale = vehicle.listing_type === 'sale';

    if (vehicle.status !== 'available') {
      return errorResponse(res, 'Vehicle is not available for booking', 400);
    }

    // Default dates for sales if missing
    let finalPickupDate = pickup_date || new Date().toISOString().split('T')[0];
    let finalReturnDate = return_date || finalPickupDate;

    let startDate = new Date(finalPickupDate);
    let endDate = new Date(finalReturnDate);

    if (!isSale) {
      if (!pickup_date || !return_date) {
        return errorResponse(res, 'Dates are required for rentals', 400);
      }
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (startDate < today) {
        return errorResponse(res, 'Pickup date cannot be in the past', 400);
      }
      if (endDate <= startDate) {
        return errorResponse(res, 'Return date must be after pickup date', 400);
      }
    }

    // Check for conflicting bookings (only for rentals)
    if (!isSale) {
      const conflictResult = await pool.query(`
        SELECT id FROM bookings 
        WHERE vehicle_id = $1 
          AND status IN ('confirmed', 'active', 'pending')
          AND (
            (start_date <= $2 AND end_date >= $2) OR
            (start_date <= $3 AND end_date >= $3) OR
            (start_date >= $2 AND end_date <= $3)
          )
      `, [vehicle_id, finalPickupDate, finalReturnDate]);

      if (conflictResult.rows.length > 0) {
        return errorResponse(res, 'Vehicle is already booked for the selected dates', 409);
      }
    }

    // Calculate duration and validate total_price
    let expectedPrice = 0;
    const durationDays = isSale ? 0 : Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));

    if (isSale) {
      expectedPrice = vehicle.selling_price || 0;
    } else {
      expectedPrice = durationDays * (vehicle.daily_rate || 0);
    }

    // Allow price differences due to currency conversion (RWF vs USD etc.)
    // Skip strict price check — Flutterwave verify-payment confirms the real amount

    // Generate a transaction ID for tracking
    const transactionId = `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Prepare payment details as JSON for storage
    const paymentDetails = {
      method: payment_method,
      ...(payment_method === 'mobile' && { telephone }),
      ...(payment_method === 'card' && { provider: 'Flutterwave' }),
      ...(flw_transaction_id && { flw_transaction_id })
    };

    // Create the booking - using only columns that exist in your schema
    const bookingResult = await pool.query(`
      INSERT INTO bookings (
        customer_id, 
        vehicle_id, 
        start_date, 
        end_date, 
        total_amount, 
        status, 
        payment_status,
        payment_method,
        payment_transaction_id,
        pickup_location,
        created_at, 
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING *
    `, [
      customer_id,
      vehicle_id,
      finalPickupDate,
      finalReturnDate,
      total_price,
      'pending', // Initial status
      'pending', // Payment status
      payment_method,
      transactionId,
      pickup_location
    ]);

    const newBooking = bookingResult.rows[0];

    // Get complete booking details with vehicle and customer info
    const completeBookingResult = await pool.query(`
      SELECT b.*, 
             v.make, v.model, v.year, v.license_plate, v.type, v.color, v.images,
             v.owner_id, v.location_address, v.daily_rate, v.selling_price, v.listing_type,
             u.first_name as customer_first_name, u.last_name as customer_last_name, 
             u.email as customer_email, u.phone as customer_phone,
             o.first_name as owner_first_name, o.last_name as owner_last_name,
             o.email as owner_email, o.phone as owner_phone
      FROM bookings b
      LEFT JOIN vehicles v ON b.vehicle_id = v.id
      LEFT JOIN users u ON b.customer_id = u.id
      LEFT JOIN users o ON v.owner_id = o.id
      WHERE b.id = $1
    `, [newBooking.id]);

    const completeBooking = completeBookingResult.rows[0];

    // Parse images if available
    if (completeBooking.images) {
      try {
        completeBooking.images = JSON.parse(completeBooking.images);
      } catch (e) {
        completeBooking.images = [];
      }
    }

    // Calculate duration_days for response
    completeBooking.duration_days = durationDays;

    // 📧 SEND EMAIL NOTIFICATIONS
    try {
      const customer = {
        first_name: completeBooking.customer_first_name,
        last_name: completeBooking.customer_last_name,
        email: completeBooking.customer_email,
        phone: completeBooking.customer_phone
      };

      const owner = {
        first_name: completeBooking.owner_first_name,
        last_name: completeBooking.owner_last_name,
        email: completeBooking.owner_email,
        phone: completeBooking.owner_phone
      };

      const vehicle = {
        make: completeBooking.make,
        model: completeBooking.model,
        year: completeBooking.year,
        license_plate: completeBooking.license_plate,
        type: completeBooking.type,
        color: completeBooking.color,
        images: completeBooking.images || []
      };

      const bookingData = {
        id: completeBooking.id,
        start_date: completeBooking.start_date,
        end_date: completeBooking.end_date,
        total_amount: completeBooking.total_amount,
        pickup_location: completeBooking.pickup_location,
        payment_method: completeBooking.payment_method,
        payment_status: completeBooking.payment_status,
        status: completeBooking.status,
        duration_days: durationDays
      };

      // Send confirmation email to customer (Non-blocking)
      emailService.sendBookingConfirmation(bookingData, customer, vehicle, owner)
        .then(() => console.log('✅ Booking confirmation email sent to customer:', customer.email))
        .catch(err => console.error('❌ Failed to send customer confirmation email:', err));

      // Send new booking notification to owner (Non-blocking)
      emailService.sendNewBookingNotification(bookingData, customer, vehicle, owner)
        .then(() => console.log('✅ New booking notification sent to owner:', owner.email))
        .catch(err => console.error('❌ Failed to send owner notification email:', err));

      // Send notification to admin
      const adminEmails = process.env.ADMIN_EMAILS ? process.env.ADMIN_EMAILS.split(',') : ['admin@autofleet.com'];
      for (const email of adminEmails) {
        await emailService.sendNewBookingAdminNotification(email.trim(), bookingData, customer, vehicle, owner);
      }
      console.log('✅ New booking notifications sent to admin team');

    } catch (emailError) {
      console.error('❌ Failed to send booking email notifications:', emailError);
      // Don't fail the booking creation if email fails
    }

    console.log('=== NEW BOOKING CREATED ===');
    console.log('Booking ID:', newBooking.id);
    console.log('Customer ID:', customer_id);
    console.log('Vehicle ID:', vehicle_id);
    console.log('Duration:', durationDays, 'days');
    console.log('Total Amount:', total_price);
    console.log('Payment Method:', payment_method);
    console.log('Transaction ID:', transactionId);

    successResponse(res, {
      booking: completeBooking,
      transaction_id: transactionId,
      payment_details: paymentDetails,
      message: 'Booking created successfully. Payment is pending.'
    }, 'Booking created successfully', 201);

  } catch (err) {
    console.error('Database error creating booking:', err);
    errorResponse(res, 'Failed to create booking. Please try again.', 500);
  }
});

// 4. Add a test email route for booking emails:
router.post('/test-booking-email', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { emailType = 'booking_confirmation', email } = req.body;

    if (!email) {
      return errorResponse(res, 'Email address is required', 400);
    }

    const testCustomer = {
      first_name: 'John',
      last_name: 'Doe',
      email: email,
      phone: '+1234567890'
    };

    const testOwner = {
      first_name: 'Jane',
      last_name: 'Smith',
      email: 'owner@test.com',
      phone: '+0987654321'
    };

    const testVehicle = {
      make: 'Toyota',
      model: 'Camry',
      year: 2023,
      license_plate: 'ABC-123',
      type: 'sedan',
      color: 'White',
      images: ['vehicle1.jpg', 'vehicle2.jpg']
    };

    const testBooking = {
      id: 12345,
      start_date: new Date(Date.now() + 24 * 60 * 60 * 1000), // Tomorrow
      end_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // Next week
      total_amount: 350.00,
      pickup_location: 'Downtown Office',
      payment_method: 'card',
      payment_status: 'paid',
      status: 'confirmed',
      duration_days: 6,
      payment_transaction_id: 'TXN_TEST_123456',
      old_status: 'pending',
      new_status: 'confirmed'
    };

    console.log(`📧 Testing ${emailType} email to ${email}`);

    let result;
    switch (emailType) {
      case 'booking_confirmation':
        result = await emailService.sendBookingConfirmation(testBooking, testCustomer, testVehicle, testOwner);
        break;
      case 'new_booking_notification':
        result = await emailService.sendNewBookingNotification(testBooking, testCustomer, testVehicle, testOwner);
        break;
      case 'booking_status_update':
        result = await emailService.sendBookingStatusUpdate(testBooking, testCustomer, 'confirmed', 'pending');
        break;
      case 'payment_confirmation':
        result = await emailService.sendPaymentConfirmation(testBooking, testCustomer, testVehicle);
        break;
      case 'booking_reminder':
        result = await emailService.sendBookingReminder(testBooking, testCustomer, testVehicle);
        break;
      default:
        result = await emailService.sendEmail(
          email,
          'Test Booking Email - AutoFleet Hub',
          `
          <h1>🚗 Booking Email System Test</h1>
          <p>This is a test email from the AutoFleet Hub booking system.</p>
          <p><strong>All booking email notifications are working correctly!</strong></p>
          <ul>
            <li>✅ Booking confirmations</li>
            <li>✅ Status updates</li>
            <li>✅ Payment confirmations</li>
            <li>✅ Owner notifications</li>
          </ul>
          <p>System tested at: ${new Date().toLocaleString()}</p>
          `
        );
    }

    if (result.success) {
      console.log('✅ Test booking email sent successfully');
      successResponse(res, {
        messageId: result.messageId,
        emailType: emailType,
        recipient: email,
        timestamp: new Date().toISOString()
      }, `${emailType} test email sent successfully`);
    } else {
      console.error('❌ Test booking email failed:', result.error);
      errorResponse(res, `Failed to send test email: ${result.error}`, 500);
    }
  } catch (err) {
    console.error('❌ Error sending test booking email:', err);
    errorResponse(res, 'Failed to send test email', 500);
  }
});

// ADMIN: Notify all admins on new booking creation
router.post('/admin/notify-new-booking', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { bookingId } = req.body;

    if (!bookingId) {
      return errorResponse(res, 'Booking ID is required', 400);
    }

    // Fetch the booking details
    const { rows: bookingRows } = await pool.query(`
      SELECT b.*, 
             u.first_name as customer_first_name, u.last_name as customer_last_name, 
             u.email as customer_email, u.phone as customer_phone,
             v.make, v.model, v.year, v.license_plate, v.type, v.color
      FROM bookings b
      LEFT JOIN users u ON b.customer_id = u.id
      LEFT JOIN vehicles v ON b.vehicle_id = v.id
      WHERE b.id = $1
    `, [bookingId]);

    const booking = bookingRows[0];

    if (!booking) {
      return errorResponse(res, 'Booking not found', 404);
    }

    // Fetch admin users
    const admins = await User.find({ role: 'admin' });

    // Create notification for each admin
    admins.forEach(async (admin) => {
      await Notification.create({
        userId: admin._id,
        type: 'booking',
        message: `A new booking has been created.`,
        bookingId: booking._id,
        // ...other fields as needed
      });
    });

    successResponse(res, null, 'Admins notified about the new booking');
  } catch (err) {
    console.error('❌ Error notifying admins about new booking:', err);
    errorResponse(res, 'Failed to notify admins', 500);
  }
});

// Initiate Paypack Payment
router.post('/initiate-payment', authenticateToken, async (req, res) => {
  const { booking_id, amount, email } = req.body;

  if (!booking_id || !amount || !email) {
    return errorResponse(res, 'Missing booking_id, amount, or email', 400);
  }

  try {
    const PAYPACK_APPLICATION_ID = process.env.PAYPACK_APPLICATINON_ID;
    const PAYPACK_SECRET_KEY = process.env.PAYPACK_APPLICATION_SECRET_KEY;
    const PAYPACK_API_URL = 'https://payments.paypack.rw';

    const reference = `autofleet-${booking_id}-${Date.now()}`;

    console.log('📱 Initiating Paypack payment:', {
      booking_id,
      amount,
      email,
      currency: 'RWF'
    });

    const paypackResponse = await axios.post(
      `${PAYPACK_API_URL}/api/transactions/initiate`,
      {
        amount: amount,
        currency: 'RWF',
        description: `Autofleet Booking #${booking_id}`,
        client_name: email,
        client_email: email,
        reference: reference
      },
      {
        headers: {
          'Authorization': `Bearer ${PAYPACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('✅ Paypack initiate response:', paypackResponse.data);

    if (paypackResponse.data.status === 'success' && paypackResponse.data.data?.payment_url) {
      return successResponse(res, {
        payment_url: paypackResponse.data.data.payment_url,
        reference: reference,
        transaction_id: paypackResponse.data.data.id
      }, 'Payment initiated successfully');
    } else {
      return errorResponse(res, 'Failed to initiate payment: ' + (paypackResponse.data.message || 'Unknown error'), 400);
    }
  } catch (error) {
    console.error('❌ Paypack initiate error:', error.response?.data || error.message);
    return errorResponse(res, 'Failed to initiate payment: ' + (error.response?.data?.message || error.message), 500);
  }
});

// Verify Flutterwave Payment
router.post('/verify-payment', authenticateToken, async (req, res) => {
  const { transaction_ref, booking_id } = req.body;

  if (!transaction_ref || !booking_id) {
    return errorResponse(res, 'Missing transaction_ref or booking_id', 400);
  }

  try {
    // 1. Verify transaction with Paypack
    const PAYPACK_APPLICATION_ID = process.env.PAYPACK_APPLICATINON_ID;
    const PAYPACK_SECRET_KEY = process.env.PAYPACK_APPLICATION_SECRET_KEY;
    const PAYPACK_API_URL = 'https://payments.paypack.rw';

    let transactionData = null;
    let amountPaid = null;
    let currency = 'RWF';
    
    try {
      const response = await axios.get(
        `${PAYPACK_API_URL}/api/transactions/${transaction_ref}`,
        {
          headers: {
            'Authorization': `Bearer ${PAYPACK_SECRET_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      if (response.data && response.data.status === 'completed') {
        transactionData = response.data;
        amountPaid = transactionData.amount;
        currency = 'RWF';
      } else {
        console.warn('Paypack verify returned non-success:', response.data?.status);
      }
    } catch (verifyErr) {
      console.warn('Paypack verify API error:', verifyErr.message || verifyErr);
      return errorResponse(res, 'Failed to verify payment with Paypack', 400);
    }
    
    // If verification failed, return error
    if (!transactionData || transactionData.status !== 'completed') {
      return errorResponse(res, 'Payment verification failed', 400);
    }

    // 2. Fetch booking to verify amount (important for security)
    const { rows: bookingRows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [booking_id]);
    const booking = bookingRows[0];

    if (!booking) {
      return errorResponse(res, 'Booking not found', 404);
    }

    // Optional: Check if amount matches
    if (Math.abs(booking.total_amount - amountPaid) > 100) { // Allow 100 RWF difference for rounding/fees
      console.warn(`Amount mismatch: Expected ${booking.total_amount}, Paid ${amountPaid}`);
    }

    // 3. Update booking status and transaction ID
    const updateResult = await pool.query(`
      UPDATE bookings 
      SET status = 'confirmed', 
          payment_status = 'completed',
          payment_transaction_id = $2,
          payment_method = 'paypack',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, [booking_id, transaction_ref]);

    const updatedBooking = updateResult.rows[0];

    // 4. Update vehicle status based on listing type
    const { rows: vehicleRows } = await pool.query('SELECT listing_type FROM vehicles WHERE id = $1', [booking.vehicle_id]);
    const vehicle = vehicleRows[0];

    if (vehicle) {
      let newVehicleStatus = 'rented';
      if (vehicle.listing_type === 'sale') {
        newVehicleStatus = 'sold';
      }

      await pool.query('UPDATE vehicles SET status = $1 WHERE id = $2', [newVehicleStatus, booking.vehicle_id]);
      console.log(`Vehicle ${booking.vehicle_id} status updated to ${newVehicleStatus}`);
    }

    // 5. Send confirmation emails
    try {
      // Re-fetch full details for email
      const { rows: fullBookingRows } = await pool.query(`
        SELECT b.*, 
               v.make, v.model, v.year, v.license_plate, v.images, v.daily_rate, v.selling_price, v.listing_type,
               u.first_name as customer_name, u.email as customer_email,
               o.first_name as owner_name, o.email as owner_email
        FROM bookings b
        JOIN vehicles v ON b.vehicle_id = v.id
        JOIN users u ON b.customer_id = u.id
        JOIN users o ON v.owner_id = o.id
        WHERE b.id = $1
      `, [booking_id]);

      const fullBooking = fullBookingRows[0];
      if (fullBooking) {
        const customer = {
          first_name: fullBooking.customer_name,
          email: fullBooking.customer_email
        };
        const owner = {
          first_name: fullBooking.owner_name,
          email: fullBooking.owner_email
        };
        const emailVehicle = {
          make: fullBooking.make,
          model: fullBooking.model,
          year: fullBooking.year,
          license_plate: fullBooking.license_plate
        };

        // Send confirmation email to customer (Non-blocking)
        emailService.sendBookingConfirmation(fullBooking, customer, emailVehicle, owner)
          .catch(err => console.error('❌ Failed to send booking confirmation email:', err));

        // Send payment confirmation email to customer (Non-blocking)
        emailService.sendPaymentConfirmation(fullBooking, customer, {
          method: fullBooking.payment_method,
          transaction_id: transaction_id
        }).catch(err => console.error('❌ Failed to send payment confirmation email:', err));

        // Send new booking notification to owner (Non-blocking)
        emailService.sendNewBookingNotification(fullBooking, customer, emailVehicle, owner)
          .catch(err => console.error('❌ Failed to send owner notification email:', err));
      }
    } catch (emailErr) {
      console.error('Failed to send confirmation emails:', emailErr);
    }

    successResponse(res, updatedBooking, 'Payment verified and booking confirmed');
  } catch (err) {
    console.error('Error verifying payment:', err);
    errorResponse(res, 'An error occurred during payment verification', 500);
  }
});

module.exports = router;
