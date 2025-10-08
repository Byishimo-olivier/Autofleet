const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/helpers');

// Get system overview
router.get('/overview', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const queries = [
      'SELECT COUNT(*) as total FROM users',
      "SELECT COUNT(*) as customers FROM users WHERE role = 'customer'",
      "SELECT COUNT(*) as owners FROM users WHERE role = 'owner'",
      "SELECT COUNT(*) as admins FROM users WHERE role = 'admin'",
      'SELECT COUNT(*) as total FROM vehicles',
      "SELECT COUNT(*) as available FROM vehicles WHERE status = 'available'",
      "SELECT COUNT(*) as rented FROM vehicles WHERE status = 'rented'",
      "SELECT COUNT(*) as maintenance FROM vehicles WHERE status = 'maintenance'"
    ];
    const results = await Promise.all(queries.map(q => pool.query(q)));
    const overview = {
      users: {
        total: results[0].rows[0].total,
        customers: results[1].rows[0].customers,
        owners: results[2].rows[0].owners,
        admins: results[3].rows[0].admins
      },
      vehicles: {
        total: results[4].rows[0].total,
        available: results[5].rows[0].available,
        rented: results[6].rows[0].rented,
        maintenance: results[7].rows[0].maintenance
      }
    };
    successResponse(res, overview, 'System overview retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Failed to retrieve system overview', 500);
  }
});


// Manage user accounts
router.get('/users', authenticateToken, requireAdmin, async (req, res) => {
  const { 
    page = 1, 
    limit = 20, 
    role, 
    status, 
    search,
    sortBy = 'created_at',
    sortOrder = 'DESC'
  } = req.query;

  const offset = (page - 1) * limit;

  let sql = `
    SELECT u.*, 
           COUNT(DISTINCT b.id) as total_bookings,
           COUNT(DISTINCT v.id) as total_vehicles,
           SUM(CASE WHEN b.payment_status = 'paid' THEN b.total_amount ELSE 0 END) as total_spent
    FROM users u
    LEFT JOIN bookings b ON u.id = b.customer_id
    LEFT JOIN vehicles v ON u.id = v.owner_id
    WHERE 1=1
  `;
  let params = [];

  if (role) {
    sql += ' AND u.role = $' + (params.length + 1);
    params.push(role);
  }

  if (search) {
    sql += ' AND (u.first_name ILIKE $' + (params.length + 1) + ' OR u.last_name ILIKE $' + (params.length + 2) + ' OR u.email ILIKE $' + (params.length + 3) + ')';
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }

  sql += ' GROUP BY u.id';

  // Validate sort parameters
  const allowedSortFields = ['created_at', 'first_name', 'last_name', 'email', 'total_bookings', 'total_spent'];
  const validSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'created_at';
  const validSortOrder = ['ASC', 'DESC'].includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';

  sql += ` ORDER BY ${validSortBy} ${validSortOrder} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(parseInt(limit), parseInt(offset));

  try {
    const usersResult = await pool.query(sql, params);
    // Get total count
    let countSql = 'SELECT COUNT(*) as total FROM users WHERE 1=1';
    let countParams = [];
    if (role) {
      countSql += ' AND role = $' + (countParams.length + 1);
      countParams.push(role);
    }
    if (search) {
      countSql += ' AND (first_name ILIKE $' + (countParams.length + 1) + ' OR last_name ILIKE $' + (countParams.length + 2) + ' OR email ILIKE $' + (countParams.length + 3) + ')';
      const searchTerm = `%${search}%`;
      countParams.push(searchTerm, searchTerm, searchTerm);
    }
    const countResult = await pool.query(countSql, countParams);
    const total = countResult.rows[0].total;
    const totalPages = Math.ceil(total / limit);
    // Remove password from response
    const safeUsers = usersResult.rows.map(user => {
      const { password, ...safeUser } = user;
      return {
        ...safeUser,
        totalSpent: parseFloat(safeUser.total_spent || 0)
      };
    });
    successResponse(res, {
      users: safeUsers,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalUsers: total,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    }, 'Users retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Database error', 500);
  }
});

// Manage vehicles
router.get('/vehicles', authenticateToken, requireAdmin, async (req, res) => {
  const { 
    page = 1, 
    limit = 20, 
    status, 
    type,
    search,
    sortBy = 'created_at',
    sortOrder = 'DESC'
  } = req.query;

  const offset = (page - 1) * limit;

  let sql = `
    SELECT v.*, 
           u.first_name as owner_first_name, u.last_name as owner_last_name, u.email as owner_email,
           COUNT(DISTINCT b.id) as total_bookings,
           SUM(CASE WHEN b.payment_status = 'paid' THEN b.total_amount ELSE 0 END) as total_revenue,
           AVG(f.rating) as avg_rating
    FROM vehicles v
    LEFT JOIN users u ON v.owner_id = u.id
    LEFT JOIN bookings b ON v.id = b.vehicle_id
    LEFT JOIN feedback f ON v.id = f.vehicle_id
    WHERE 1=1
  `;
  let params = [];

  if (status) {
    sql += ' AND v.status = $' + (params.length + 1);
    params.push(status);
  }

  if (type) {
    sql += ' AND v.type = $' + (params.length + 1);
    params.push(type);
  }

  if (search) {
    sql += ' AND (v.make ILIKE $' + (params.length + 1) + ' OR v.model ILIKE $' + (params.length + 2) + ' OR v.license_plate ILIKE $' + (params.length + 3) + ')';
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }

  sql += ' GROUP BY v.id, u.first_name, u.last_name, u.email';

  // Validate sort parameters
  const allowedSortFields = ['created_at', 'make', 'model', 'daily_rate', 'total_bookings', 'total_revenue'];
  const validSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'created_at';
  const validSortOrder = ['ASC', 'DESC'].includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';

  sql += ` ORDER BY ${validSortBy} ${validSortOrder} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(parseInt(limit), parseInt(offset));

  try {
    const vehiclesResult = await pool.query(sql, params);
    // Parse JSON fields and format data
    const formattedVehicles = vehiclesResult.rows.map(vehicle => ({
      ...vehicle,
      features: vehicle.features ? JSON.parse(vehicle.features) : [],
      images: vehicle.images ? JSON.parse(vehicle.images) : [],
      totalRevenue: parseFloat(vehicle.total_revenue || 0),
      avgRating: vehicle.avg_rating ? parseFloat(vehicle.avg_rating.toFixed(2)) : 0
    }));
    // Get total count
    let countSql = 'SELECT COUNT(*) as total FROM vehicles WHERE 1=1';
    let countParams = [];
    if (status) {
      countSql += ' AND status = $' + (countParams.length + 1);
      countParams.push(status);
    }
    if (type) {
      countSql += ' AND type = $' + (countParams.length + 1);
      countParams.push(type);
    }
    if (search) {
      countSql += ' AND (make ILIKE $' + (countParams.length + 1) + ' OR model ILIKE $' + (countParams.length + 2) + ' OR license_plate ILIKE $' + (countParams.length + 3) + ')';
      const searchTerm = `%${search}%`;
      countParams.push(searchTerm, searchTerm, searchTerm);
    }
    const countResult = await pool.query(countSql, countParams);
    const total = countResult.rows[0].total;
    const totalPages = Math.ceil(total / limit);
    successResponse(res, {
      vehicles: formattedVehicles,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalVehicles: total,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    }, 'Vehicles retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Database error', 500);
  }
});

// System maintenance
router.post('/maintenance/cleanup', authenticateToken, requireAdmin, async (req, res) => {
  const { action } = req.body;
  if (!action) {
    return errorResponse(res, 'Maintenance action is required', 400);
  }
  let sql = '';
  let message = '';
  switch (action) {
    case 'clean_old_notifications':
      sql = `DELETE FROM notifications WHERE created_at < NOW() - INTERVAL '90 days' AND is_read = TRUE`;
      message = 'Old read notifications cleaned up';
      break;
    case 'clean_cancelled_bookings':
      sql = `DELETE FROM bookings WHERE status = 'cancelled' AND created_at < NOW() - INTERVAL '180 days'`;
      message = 'Old cancelled bookings cleaned up';
      break;
    case 'reset_vehicle_tracking':
      sql = `DELETE FROM vehicle_tracking WHERE timestamp < NOW() - INTERVAL '30 days'`;
      message = 'Old vehicle tracking data cleaned up';
      break;
    default:
      return errorResponse(res, 'Invalid maintenance action', 400);
  }
  try {
    const result = await pool.query(sql);
    successResponse(res, {
      deletedRows: result.rowCount,
      action,
      message
    }, message);
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Maintenance operation failed', 500);
  }
});

// Export data
router.get('/export/:type', authenticateToken, requireAdmin, async (req, res) => {
  const { type } = req.params;
  const { startDate, endDate } = req.query;
  let sql = '';
  let filename = '';
  switch (type) {
    case 'users':
      sql = 'SELECT id, email, first_name, last_name, phone, role, created_at FROM users';
      filename = 'users_export.csv';
      break;
    case 'bookings':
      sql = `SELECT b.id, b.customer_id, b.vehicle_id, b.start_date, b.end_date, b.total_amount, b.status, b.payment_status, b.created_at, u.email as customer_email, v.make, v.model, v.license_plate FROM bookings b LEFT JOIN users u ON b.customer_id = u.id LEFT JOIN vehicles v ON b.vehicle_id = v.id`;
      filename = 'bookings_export.csv';
      break;
    case 'vehicles':
      sql = `SELECT v.id, v.make, v.model, v.year, v.type, v.license_plate, v.daily_rate, v.status, v.created_at, u.email as owner_email FROM vehicles v LEFT JOIN users u ON v.owner_id = u.id`;
      filename = 'vehicles_export.csv';
      break;
    case 'feedback':
      sql = `SELECT f.id, f.booking_id, f.vehicle_id, f.rating, f.comment, f.created_at, u.email as customer_email, v.make, v.model FROM feedback f LEFT JOIN users u ON f.customer_id = u.id LEFT JOIN vehicles v ON f.vehicle_id = v.id`;
      filename = 'feedback_export.csv';
      break;
    default:
      return errorResponse(res, 'Invalid export type', 400);
  }
  // Add date filtering if provided
  if (startDate && endDate) {
    sql += ` WHERE created_at BETWEEN $1 AND $2`;
  }
  sql += ' ORDER BY created_at DESC';
  try {
    const params = (startDate && endDate) ? [startDate, endDate] : [];
    const result = await pool.query(sql, params);
    const data = result.rows;
    if (data.length === 0) {
      return errorResponse(res, 'No data to export', 404);
    }
    // Convert to CSV format
    const headers = Object.keys(data[0]);
    const csvContent = [
      headers.join(','),
      ...data.map(row =>
        headers.map(header => {
          const value = row[header];
          // Escape commas and quotes in CSV
          if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
            return `"${value.replace(/"/g, '""')}"`;
          }
          return value !== null && value !== undefined ? value : '';
        }).join(',')
      )
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Export failed', 500);
  }
});

module.exports = router;

