
const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/helpers');

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
      if (booking.images) {
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

// Get all bookings with filtering
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
      if (booking.images) {
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

// Get booking by ID
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
    if (booking.images) {
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

// Get booking statistics
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

// Update booking status
router.put('/:id/status', authenticateToken, async (req, res) => {
  const bookingId = req.params.id;
  const { status } = req.body;
  const requestingUserId = req.user.id;
  const requestingUserRole = req.user.role;

  if (!status || !['pending', 'confirmed', 'active', 'completed', 'cancelled'].includes(status)) {
    return errorResponse(res, 'Valid status is required', 400);
  }

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
    } else if (status === 'completed' || status === 'cancelled') {
      await pool.query('UPDATE vehicles SET status = $1 WHERE id = $2', ['available', booking.vehicle_id]);
    }
    
    successResponse(res, null, 'Booking status updated successfully');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Failed to update booking status', 500);
  }
});

// Process payment for booking
router.post('/:id/payment', authenticateToken, async (req, res) => {
  const bookingId = req.params.id;
  const { paymentMethod, transactionId } = req.body;
  const requestingUserId = req.user.id;

  if (!paymentMethod) {
    return errorResponse(res, 'Payment method is required', 400);
  }

  try {
    // Get booking details
    const { rows } = await pool.query(
      'SELECT * FROM bookings WHERE id = $1 AND customer_id = $2', 
      [bookingId, requestingUserId]
    );
    
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
    
    successResponse(res, null, 'Payment processed successfully');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Failed to process payment', 500);
  }
});

// Cancel booking
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
    
    // Check permissions
    const canCancel = requestingUserRole === 'admin' || 
                     booking.customer_id === requestingUserId ||
                     booking.owner_id === requestingUserId;
    
    if (!canCancel) {
      return errorResponse(res, 'Access denied', 403);
    }
    
    if (!['pending', 'confirmed'].includes(booking.status)) {
      return errorResponse(res, 'Cannot cancel booking in current status', 400);
    }
    
    // Update booking status to cancelled
    await pool.query(`
      UPDATE bookings 
      SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP 
      WHERE id = $1
    `, [bookingId]);
    
    // Make vehicle available again
    await pool.query(
      'UPDATE vehicles SET status = $1 WHERE id = $2', 
      ['available', booking.vehicle_id]
    );
    
    successResponse(res, null, 'Booking cancelled successfully');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Failed to cancel booking', 500);
  }
});

module.exports = router;