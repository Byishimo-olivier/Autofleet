
const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/helpers');

// Get all users (admin only)
router.get('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 10, role, search } = req.query;
    const offset = (page - 1) * limit;
    let sql = `SELECT id, email, first_name, last_name, phone, role, created_at, updated_at FROM users WHERE 1=1`;
    let params = [];
    let paramIdx = 1;

    if (role) {
      sql += ` AND role = $${paramIdx++}`;
      params.push(role);
    }
    if (search) {
      sql += ` AND (first_name ILIKE $${paramIdx} OR last_name ILIKE $${paramIdx+1} OR email ILIKE $${paramIdx+2})`;
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
      paramIdx += 3;
    }
    sql += ` ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`;
    params.push(parseInt(limit), parseInt(offset));

    const usersResult = await pool.query(sql, params);
    const users = usersResult.rows;

    // Get total count
    let countSql = 'SELECT COUNT(*) as total FROM users WHERE 1=1';
    let countParams = [];
    let countIdx = 1;
    if (role) {
      countSql += ` AND role = $${countIdx++}`;
      countParams.push(role);
    }
    if (search) {
      countSql += ` AND (first_name ILIKE $${countIdx} OR last_name ILIKE $${countIdx+1} OR email ILIKE $${countIdx+2})`;
      const searchTerm = `%${search}%`;
      countParams.push(searchTerm, searchTerm, searchTerm);
      countIdx += 3;
    }
    const countResult = await pool.query(countSql, countParams);
    const total = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(total / limit);

    successResponse(res, {
      users,
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
    return errorResponse(res, 'Database error', 500);
  }
});

// Get user by ID
router.get('/:id', authenticateToken, async (req, res) => {
  const userId = req.params.id;
  const requestingUserId = req.user.id;
  const requestingUserRole = req.user.role;

  if (requestingUserRole !== 'admin' && parseInt(userId) !== requestingUserId) {
    return errorResponse(res, 'Access denied', 403);
  }
  try {
    const result = await pool.query(
      `SELECT id, email, first_name, last_name, phone, role, created_at, updated_at FROM users WHERE id = $1`,
      [userId]
    );
    const user = result.rows[0];
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }
    successResponse(res, user, 'User retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Database error', 500);
  }
});

// Update user role (admin only)
router.put('/:id/role', authenticateToken, requireAdmin, async (req, res) => {
  const userId = req.params.id;
  const { role } = req.body;

  if (!role || !['customer', 'owner', 'admin'].includes(role)) {
    return errorResponse(res, 'Valid role is required (customer, owner, admin)', 400);
  }
  try {
    const result = await pool.query(
      `UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2`,
      [role, userId]
    );
    if (result.rowCount === 0) {
      return errorResponse(res, 'User not found', 404);
    }
    successResponse(res, null, 'User role updated successfully');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Failed to update user role', 500);
  }
});

// Delete user (admin only)
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  const userId = req.params.id;
  try {
    // Check if user has active bookings
    const activeBookingsResult = await pool.query(
      `SELECT COUNT(*) as activeBookings FROM bookings WHERE customer_id = $1 AND status IN ('pending', 'confirmed', 'active')`,
      [userId]
    );
    if (parseInt(activeBookingsResult.rows[0].activebookings) > 0) {
      return errorResponse(res, 'Cannot delete user with active bookings', 400);
    }
    // Delete user
    const deleteResult = await pool.query(
      `DELETE FROM users WHERE id = $1`,
      [userId]
    );
    if (deleteResult.rowCount === 0) {
      return errorResponse(res, 'User not found', 404);
    }
    successResponse(res, null, 'User deleted successfully');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Failed to delete user', 500);
  }
});

// Get user statistics (admin only)
router.get('/stats/overview', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const queries = [
      `SELECT COUNT(*) as total FROM users`,
      `SELECT COUNT(*) as customers FROM users WHERE role = 'customer'`,
      `SELECT COUNT(*) as owners FROM users WHERE role = 'owner'`,
      `SELECT COUNT(*) as admins FROM users WHERE role = 'admin'`,
      `SELECT COUNT(*) as newThisMonth FROM users WHERE date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)`
    ];
    const results = await Promise.all(queries.map(q => pool.query(q)));
    const stats = {
      totalUsers: parseInt(results[0].rows[0].total),
      customers: parseInt(results[1].rows[0].customers),
      owners: parseInt(results[2].rows[0].owners),
      admins: parseInt(results[3].rows[0].admins),
      newThisMonth: parseInt(results[4].rows[0].newthismonth)
    };
    successResponse(res, stats, 'User statistics retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Failed to retrieve user statistics', 500);
  }
});

module.exports = router;

