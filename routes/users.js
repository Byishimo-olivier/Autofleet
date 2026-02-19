const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const bcrypt = require('bcryptjs');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/helpers');

// ADMIN: Get all users with advanced filtering and search
router.get('/admin/all', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      role,
      search,
      status,
      sortBy = 'created_at',
      sortOrder = 'DESC'
    } = req.query;

    const offset = (page - 1) * limit;
    console.log('=== ADMIN USERS QUERY ===');
    console.log('Filters:', { role, search, status, sortBy, sortOrder });

    // Build main query
    let sql = `
      SELECT 
        u.id,
        u.email,
        u.first_name,
        u.last_name,
        u.phone,
        u.role,
        u.created_at,
        u.updated_at,
        -- Calculate user status based on recent activity
        CASE 
          WHEN u.updated_at >= NOW() - INTERVAL '30 days' THEN 'Active'
          ELSE 'Inactive'
        END as status,
        -- Get user statistics
        (SELECT COUNT(*) FROM bookings WHERE customer_id = u.id) as total_bookings,
        (SELECT COUNT(*) FROM vehicles WHERE owner_id = u.id) as total_vehicles
      FROM users u
      WHERE 1=1
    `;

    let params = [];
    let paramCount = 0;

    // Role filter
    if (role && role !== 'all') {
      paramCount++;
      sql += ` AND u.role = $${paramCount}`;
      params.push(role);
    }

    // Search filter (name, email)
    if (search && search.trim()) {
      paramCount++;
      sql += ` AND (
        LOWER(CONCAT(u.first_name, ' ', u.last_name)) LIKE LOWER($${paramCount}) OR
        LOWER(u.email) LIKE LOWER($${paramCount}) OR
        LOWER(u.first_name) LIKE LOWER($${paramCount}) OR
        LOWER(u.last_name) LIKE LOWER($${paramCount})
      )`;
      params.push(`%${search.trim()}%`);
    }

    // Status filter (if needed in future)
    if (status && status !== 'all') {
      // This would require additional logic based on your status definition
      console.log('Status filter requested:', status);
    }

    // Sorting
    const allowedSortFields = ['created_at', 'first_name', 'last_name', 'email', 'role'];
    const validSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'created_at';
    const validSortOrder = ['ASC', 'DESC'].includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';

    sql += ` ORDER BY u.${validSortBy} ${validSortOrder}`;

    // Pagination
    sql += ` LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    // Execute main query
    const result = await pool.query(sql, params);
    const users = result.rows.map(user => ({
      ...user,
      full_name: `${user.first_name || ''} ${user.last_name || ''}`.trim(),
      total_bookings: parseInt(user.total_bookings || 0),
      total_vehicles: parseInt(user.total_vehicles || 0)
    }));

    // Get total count for pagination
    let countSql = `SELECT COUNT(*) as total FROM users u WHERE 1=1`;
    let countParams = [];
    let countParamCount = 0;

    // Apply same filters for count
    if (role && role !== 'all') {
      countParamCount++;
      countSql += ` AND u.role = $${countParamCount}`;
      countParams.push(role);
    }

    if (search && search.trim()) {
      countParamCount++;
      countSql += ` AND (
        LOWER(CONCAT(u.first_name, ' ', u.last_name)) LIKE LOWER($${countParamCount}) OR
        LOWER(u.email) LIKE LOWER($${countParamCount}) OR
        LOWER(u.first_name) LIKE LOWER($${countParamCount}) OR
        LOWER(u.last_name) LIKE LOWER($${countParamCount})
      )`;
      countParams.push(`%${search.trim()}%`);
    }

    const countResult = await pool.query(countSql, countParams);
    const total = parseInt(countResult.rows[0].total);

    console.log('📊 Admin users result:', {
      totalFound: total,
      currentPage: users.length,
      filters: { role, search, status }
    });

    successResponse(res, {
      users,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit),
        hasNext: page * limit < total,
        hasPrev: page > 1
      },
      filters: {
        role,
        search,
        status,
        sortBy: validSortBy,
        sortOrder: validSortOrder
      }
    }, 'Admin users retrieved successfully');

  } catch (err) {
    console.error('❌ Database error in admin users:', err);
    errorResponse(res, 'Failed to retrieve admin users', 500);
  }
});

// ADMIN: Get user statistics by role
router.get('/admin/stats/roles', authenticateToken, requireAdmin, async (req, res) => {
  try {
    console.log('🔍 Getting user role statistics...');

    const rolesQuery = `
      SELECT 
        COUNT(*) as total_users,
        COUNT(CASE WHEN role = 'admin' THEN 1 END) as admins,
        COUNT(CASE WHEN role = 'owner' THEN 1 END) as rental_agencies,
        COUNT(CASE WHEN role = 'customer' THEN 1 END) as customers,
        -- Active users (updated in last 30 days)
        COUNT(CASE WHEN updated_at >= NOW() - INTERVAL '30 days' THEN 1 END) as active_users,
        -- New users this month
        COUNT(CASE WHEN created_at >= DATE_TRUNC('month', CURRENT_DATE) THEN 1 END) as new_this_month
      FROM users
    `;

    const result = await pool.query(rolesQuery);
    const stats = result.rows[0];

    const roleStats = {
      total_users: parseInt(stats.total_users || 0),
      admins: parseInt(stats.admins || 0),
      rental_agencies: parseInt(stats.rental_agencies || 0),
      customers: parseInt(stats.customers || 0),
      active_users: parseInt(stats.active_users || 0),
      new_this_month: parseInt(stats.new_this_month || 0)
    };

    console.log('👥 User role stats:', roleStats);

    successResponse(res, roleStats, 'User role statistics retrieved successfully');
  } catch (err) {
    console.error('❌ Database error in user role stats:', err);
    errorResponse(res, 'Failed to retrieve user role statistics', 500);
  }
});

// ADMIN: Create new user
router.post('/admin/create', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const {
      email,
      password,
      first_name,
      last_name,
      phone,
      role = 'customer'
    } = req.body;

    // Validation
    if (!email || !password || !first_name || !last_name) {
      return errorResponse(res, 'Email, password, first name, and last name are required', 400);
    }

    if (!['customer', 'owner', 'admin'].includes(role)) {
      return errorResponse(res, 'Invalid role. Must be customer, owner, or admin', 400);
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return errorResponse(res, 'Invalid email format', 400);
    }

    // Password validation (at least 6 characters)
    if (password.length < 6) {
      return errorResponse(res, 'Password must be at least 6 characters long', 400);
    }

    console.log('👤 Creating new user:', { email, role, first_name, last_name });

    // Check if user already exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (existingUser.rows.length > 0) {
      return errorResponse(res, 'User with this email already exists', 409);
    }

    // Hash password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Create user
    const result = await pool.query(`
      INSERT INTO users (email, password, first_name, last_name, phone, role, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      RETURNING id, email, first_name, last_name, phone, role, created_at
    `, [email.toLowerCase(), hashedPassword, first_name, last_name, phone, role]);

    const newUser = result.rows[0];

    console.log('✅ User created successfully:', newUser.id);

    successResponse(res, {
      user: newUser,
      message: 'User created successfully'
    }, 'User created successfully', 201);

  } catch (err) {
    console.error('❌ Database error creating user:', err);
    errorResponse(res, 'Failed to create user', 500);
  }
});

// ADMIN: Bulk update user status/role
router.put('/admin/bulk-update', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userIds, action, value } = req.body;

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return errorResponse(res, 'User IDs array is required', 400);
    }

    if (!action || !['role', 'status'].includes(action)) {
      return errorResponse(res, 'Action must be "role" or "status"', 400);
    }

    console.log('📝 Bulk updating users:', { userIds, action, value });

    let sql;
    let params;

    if (action === 'role') {
      if (!value || !['customer', 'owner', 'admin'].includes(value)) {
        return errorResponse(res, 'Valid role is required', 400);
      }

      const placeholders = userIds.map((_, index) => `$${index + 1}`).join(',');
      sql = `UPDATE users SET role = $${userIds.length + 1}, updated_at = NOW() WHERE id IN (${placeholders})`;
      params = [...userIds, value];
    } else if (action === 'status') {
      // For status updates, we could update the updated_at field to mark as active
      // or implement a separate status field if needed
      const placeholders = userIds.map((_, index) => `$${index + 1}`).join(',');
      sql = `UPDATE users SET updated_at = NOW() WHERE id IN (${placeholders})`;
      params = userIds;
    }

    const result = await pool.query(sql, params);

    console.log('✅ Bulk update result:', result.rowCount, 'users updated');

    successResponse(res, {
      updatedCount: result.rowCount,
      userIds,
      action,
      value
    }, `${result.rowCount} users updated successfully`);

  } catch (err) {
    console.error('❌ Database error in bulk user update:', err);
    errorResponse(res, 'Failed to update users', 500);
  }
});

// ADMIN: Get detailed user information
router.get('/admin/:id/details', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    console.log('🔍 Getting detailed user info for ID:', userId);

    const sql = `
      SELECT 
        u.*,
        -- Booking statistics
        (SELECT COUNT(*) FROM bookings WHERE customer_id = u.id) as total_bookings,
        (SELECT COUNT(*) FROM bookings WHERE customer_id = u.id AND status = 'completed') as completed_bookings,
        (SELECT COALESCE(SUM(total_amount), 0) FROM bookings WHERE customer_id = u.id AND payment_status = 'paid') as total_spent,
        -- Vehicle statistics (for owners)
        (SELECT COUNT(*) FROM vehicles WHERE owner_id = u.id) as total_vehicles,
        (SELECT COUNT(*) FROM vehicles WHERE owner_id = u.id AND status = 'available') as available_vehicles,
        -- Recent activity
        (SELECT MAX(created_at) FROM bookings WHERE customer_id = u.id) as last_booking_date
      FROM users u
      WHERE u.id = $1
    `;

    const result = await pool.query(sql, [userId]);
    const user = result.rows[0];

    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    // Get recent bookings
    const recentBookingsResult = await pool.query(`
      SELECT 
        b.id,
        b.start_date,
        b.end_date,
        b.total_amount,
        b.status,
        v.make,
        v.model,
        v.year
      FROM bookings b
      LEFT JOIN vehicles v ON b.vehicle_id = v.id
      WHERE b.customer_id = $1
      ORDER BY b.created_at DESC
      LIMIT 5
    `, [userId]);

    // Get user's vehicles (if owner)
    const vehiclesResult = await pool.query(`
      SELECT 
        id,
        make,
        model,
        year,
        status,
        daily_rate
      FROM vehicles
      WHERE owner_id = $1
      ORDER BY created_at DESC
      LIMIT 5
    `, [userId]);

    const detailedUser = {
      ...user,
      full_name: `${user.first_name || ''} ${user.last_name || ''}`.trim(),
      total_bookings: parseInt(user.total_bookings || 0),
      completed_bookings: parseInt(user.completed_bookings || 0),
      total_spent: parseFloat(user.total_spent || 0),
      total_vehicles: parseInt(user.total_vehicles || 0),
      available_vehicles: parseInt(user.available_vehicles || 0),
      recent_bookings: recentBookingsResult.rows,
      vehicles: vehiclesResult.rows
    };

    console.log('✅ Detailed user info retrieved for:', user.email);

    successResponse(res, detailedUser, 'Detailed user information retrieved successfully');
  } catch (err) {
    console.error('❌ Database error in detailed user info:', err);
    errorResponse(res, 'Failed to retrieve detailed user information', 500);
  }
});

// ADMIN: Export users data
router.get('/admin/export', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const {
      role,
      format = 'json' // json or csv
    } = req.query;

    console.log('📤 Exporting users:', { role, format });

    let sql = `
      SELECT 
        u.id,
        u.email,
        u.first_name,
        u.last_name,
        u.phone,
        u.role,
        u.created_at,
        u.updated_at,
        (SELECT COUNT(*) FROM bookings WHERE customer_id = u.id) as total_bookings,
        (SELECT COUNT(*) FROM vehicles WHERE owner_id = u.id) as total_vehicles
      FROM users u
      WHERE 1=1
    `;

    let params = [];
    let paramCount = 0;

    // Apply role filter
    if (role && role !== 'all') {
      paramCount++;
      sql += ` AND u.role = $${paramCount}`;
      params.push(role);
    }

    sql += ` ORDER BY u.created_at DESC`;

    const result = await pool.query(sql, params);
    const users = result.rows;

    console.log('📊 Export data:', users.length, 'users');

    if (format === 'csv') {
      // Convert to CSV format
      const csvHeaders = [
        'ID', 'Email', 'First Name', 'Last Name', 'Phone', 'Role',
        'Total Bookings', 'Total Vehicles', 'Created At'
      ].join(',');

      const csvRows = users.map(u => [
        u.id,
        `"${u.email || ''}"`,
        `"${u.first_name || ''}"`,
        `"${u.last_name || ''}"`,
        `"${u.phone || ''}"`,
        u.role,
        u.total_bookings || 0,
        u.total_vehicles || 0,
        u.created_at ? new Date(u.created_at).toISOString() : ''
      ].join(','));

      const csvContent = [csvHeaders, ...csvRows].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="users-export-${Date.now()}.csv"`);
      res.send(csvContent);
    } else {
      // Return JSON format
      successResponse(res, {
        users,
        exportInfo: {
          totalRecords: users.length,
          filters: { role },
          exportDate: new Date().toISOString(),
          format
        }
      }, 'Users exported successfully');
    }

  } catch (err) {
    console.error('❌ Database error in users export:', err);
    errorResponse(res, 'Failed to export users', 500);
  }
});

// Get all users (admin only) - EXISTING ROUTE - UPDATED
router.get('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 10, role, search } = req.query;
    const offset = (page - 1) * limit;
    let sql = `
      SELECT 
        u.id, 
        u.email, 
        u.first_name, 
        u.last_name, 
        u.phone, 
        u.role, 
        u.created_at, 
        u.updated_at,
        CASE 
          WHEN u.updated_at >= NOW() - INTERVAL '30 days' THEN 'Active'
          ELSE 'Inactive'
        END as status
      FROM users u WHERE 1=1
    `;
    let params = [];
    let paramIdx = 1;

    if (role) {
      sql += ` AND role = $${paramIdx++}`;
      params.push(role);
    }
    if (search) {
      sql += ` AND (first_name ILIKE $${paramIdx} OR last_name ILIKE $${paramIdx + 1} OR email ILIKE $${paramIdx + 2})`;
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
      paramIdx += 3;
    }
    sql += ` ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`;
    params.push(parseInt(limit), parseInt(offset));

    const usersResult = await pool.query(sql, params);
    const users = usersResult.rows.map(user => ({
      ...user,
      full_name: `${user.first_name || ''} ${user.last_name || ''}`.trim()
    }));

    // Get total count
    let countSql = 'SELECT COUNT(*) as total FROM users WHERE 1=1';
    let countParams = [];
    let countIdx = 1;
    if (role) {
      countSql += ` AND role = $${countIdx++}`;
      countParams.push(role);
    }
    if (search) {
      countSql += ` AND (first_name ILIKE $${countIdx} OR last_name ILIKE $${countIdx + 1} OR email ILIKE $${countIdx + 2})`;
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

// Get user statistics (admin only) - MOVED BEFORE /:id route
router.get('/stats/overview', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const userStatsResult = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN role = 'customer' THEN 1 END) as customers,
        COUNT(CASE WHEN role = 'owner' THEN 1 END) as owners,
        COUNT(CASE WHEN role = 'admin' THEN 1 END) as admins,
        COUNT(CASE WHEN date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE) THEN 1 END) as newThisMonth
      FROM users
    `);

    const stats = userStatsResult.rows[0];
    const result = {
      totalUsers: parseInt(stats.total || 0),
      customers: parseInt(stats.customers || 0),
      owners: parseInt(stats.owners || 0),
      admins: parseInt(stats.admins || 0),
      newThisMonth: parseInt(stats.newthismonth || 0)
    };

    successResponse(res, result, 'User statistics retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Failed to retrieve user statistics', 500);
  }
});

// Get user settings - MOVED BEFORE /:id route
router.get('/settings', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    console.log('=== GETTING USER SETTINGS ===');
    console.log('User ID:', userId);

    // Get user data
    const userResult = await pool.query(
      `SELECT id, email, first_name, last_name, phone, role, created_at, updated_at FROM users WHERE id = $1`,
      [userId]
    );

    const user = userResult.rows[0];
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    console.log('User found:', user.email);

    // Get user preferences if they exist in a settings table
    let preferences = {
      language: 'en',
      currency: 'RWF',
      darkMode: false,
      notifications: {
        email: true,
        sms: false,
        push: true
      },
      privacy: {
        showProfile: true,
        showEmail: false,
        showPhone: false
      }
    };

    try {
      // Try to get user preferences from a settings table if it exists
      const settingsResult = await pool.query(
        `SELECT preferences FROM user_settings WHERE user_id = $1`,
        [userId]
      );

      if (settingsResult.rows.length > 0) {
        preferences = { ...preferences, ...settingsResult.rows[0].preferences };
        console.log('Custom preferences loaded');
      } else {
        console.log('No custom preferences found, using defaults');
      }
    } catch (settingsError) {
      // Settings table doesn't exist, use defaults
      console.log('User settings table not found, using defaults');
    }

    const response = {
      user,
      preferences
    };

    console.log('=== SETTINGS RESPONSE ===');
    console.log('Response:', response);

    successResponse(res, response, 'User settings retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Failed to retrieve user settings', 500);
  }
});

// Update user settings - MOVED BEFORE /:id route
router.put('/settings', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { user, preferences } = req.body;

    console.log('=== UPDATING USER SETTINGS ===');
    console.log('User ID:', userId);
    console.log('Update data:', { user, preferences });

    // Update user basic info if provided
    if (user) {
      const updateFields = [];
      const updateValues = [];
      let paramIdx = 1;

      if (user.first_name !== undefined) {
        updateFields.push(`first_name = $${paramIdx++}`);
        updateValues.push(user.first_name);
      }
      if (user.last_name !== undefined) {
        updateFields.push(`last_name = $${paramIdx++}`);
        updateValues.push(user.last_name);
      }
      if (user.phone !== undefined) {
        updateFields.push(`phone = $${paramIdx++}`);
        updateValues.push(user.phone);
      }

      if (updateFields.length > 0) {
        updateFields.push(`updated_at = NOW()`);
        updateValues.push(userId);

        const updateSql = `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${paramIdx}`;
        console.log('Updating user with SQL:', updateSql, 'Values:', updateValues);
        await pool.query(updateSql, updateValues);
        console.log('User info updated successfully');
      }
    }

    // Update preferences if provided
    if (preferences) {
      try {
        // Try to upsert preferences
        await pool.query(
          `INSERT INTO user_settings (user_id, preferences, created_at, updated_at) 
           VALUES ($1, $2, NOW(), NOW())
           ON CONFLICT (user_id) 
           DO UPDATE SET preferences = $2, updated_at = NOW()`,
          [userId, JSON.stringify(preferences)]
        );
        console.log('Preferences updated successfully');
      } catch (settingsError) {
        // Settings table doesn't exist, that's ok for now
        console.log('User settings table not found, skipping preferences update');
      }
    }

    successResponse(res, null, 'User settings updated successfully');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Failed to update user settings', 500);
  }
});

// Update user profile - MOVED BEFORE /:id route
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { first_name, last_name, phone } = req.body;

    const updateFields = [];
    const updateValues = [];
    let paramIdx = 1;

    if (first_name !== undefined) {
      updateFields.push(`first_name = $${paramIdx++}`);
      updateValues.push(first_name);
    }
    if (last_name !== undefined) {
      updateFields.push(`last_name = $${paramIdx++}`);
      updateValues.push(last_name);
    }
    if (phone !== undefined) {
      updateFields.push(`phone = $${paramIdx++}`);
      updateValues.push(phone);
    }

    if (updateFields.length === 0) {
      return errorResponse(res, 'No fields to update', 400);
    }

    updateFields.push(`updated_at = NOW()`);
    updateValues.push(userId);

    const updateSql = `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${paramIdx}`;
    const result = await pool.query(updateSql, updateValues);

    if (result.rowCount === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    // Get updated user data
    const userResult = await pool.query(
      `SELECT id, email, first_name, last_name, phone, role, created_at, updated_at FROM users WHERE id = $1`,
      [userId]
    );

    successResponse(res, userResult.rows[0], 'Profile updated successfully');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Failed to update profile', 500);
  }
});

// Get user by ID - MOVED AFTER specific routes
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.params.id;
    const requestingUserId = req.user.id;
    const requestingUserRole = req.user.role;

    // No more redirect needed since settings route is now above this one

    // Validate that userId is a number
    const userIdInt = parseInt(userId);
    if (isNaN(userIdInt)) {
      return errorResponse(res, 'Invalid user ID', 400);
    }

    if (requestingUserRole !== 'admin' && userIdInt !== requestingUserId) {
      return errorResponse(res, 'Access denied', 403);
    }

    const result = await pool.query(
      `SELECT id, email, first_name, last_name, phone, role, created_at, updated_at FROM users WHERE id = $1`,
      [userIdInt]
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
  try {
    const userId = req.params.id;
    const { role } = req.body;

    // Validate that userId is a number
    const userIdInt = parseInt(userId);
    if (isNaN(userIdInt)) {
      return errorResponse(res, 'Invalid user ID', 400);
    }

    if (!role || !['customer', 'owner', 'admin'].includes(role)) {
      return errorResponse(res, 'Valid role is required (customer, owner, admin)', 400);
    }

    const result = await pool.query(
      `UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2`,
      [role, userIdInt]
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
  try {
    const userId = req.params.id;

    // Validate that userId is a number
    const userIdInt = parseInt(userId);
    if (isNaN(userIdInt)) {
      return errorResponse(res, 'Invalid user ID', 400);
    }

    // Check if user has active bookings
    const activeBookingsResult = await pool.query(
      `SELECT COUNT(*) as activeBookings FROM bookings WHERE customer_id = $1 AND status IN ('pending', 'confirmed', 'active')`,
      [userIdInt]
    );

    if (parseInt(activeBookingsResult.rows[0].activebookings) > 0) {
      return errorResponse(res, 'Cannot delete user with active bookings', 400);
    }

    // Delete user
    const deleteResult = await pool.query(
      `DELETE FROM users WHERE id = $1`,
      [userIdInt]
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

module.exports = router;

