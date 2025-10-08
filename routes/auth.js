const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { hashPassword, comparePassword, validateEmail, successResponse, errorResponse } = require('../utils/helpers');
const { generateToken, authenticateToken } = require('../middleware/auth');

// Register new user
router.post('/register', async (req, res) => {
  try {
    const { email, password, firstName, lastName, phone, role = 'customer' } = req.body;

    // Validation
    if (!email || !password || !firstName || !lastName) {
      return errorResponse(res, 'Email, password, first name, and last name are required', 400);
    }

    if (!validateEmail(email)) {
      return errorResponse(res, 'Invalid email format', 400);
    }

    if (password.length < 6) {
      return errorResponse(res, 'Password must be at least 6 characters long', 400);
    }

    // Check if user already exists
    const existingUserResult = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUserResult.rows.length > 0) {
      return errorResponse(res, 'User with this email already exists', 409);
    }
    // Hash password
    const hashedPassword = await hashPassword(password);
    // Insert new user
    const insertResult = await pool.query(
      `INSERT INTO users (email, password, first_name, last_name, phone, role)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [email, hashedPassword, firstName, lastName, phone, role]
    );
    const user = {
      id: insertResult.rows[0].id,
      email,
      firstName,
      lastName,
      phone,
      role
    };
    const token = generateToken(user);
    successResponse(res, { user, token }, 'User registered successfully');
  } catch (error) {
    console.error('Registration error:', error);
    errorResponse(res, 'Internal server error', 500);
  }
});

// Login user
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return errorResponse(res, 'Email and password are required', 400);
    }

    // Find user by email
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = userResult.rows[0];
    if (!user) {
      return errorResponse(res, 'Invalid email or password', 401);
    }
    // Compare password
    const isValidPassword = await comparePassword(password, user.password);
    if (!isValidPassword) {
      return errorResponse(res, 'Invalid email or password', 401);
    }
    // Generate token
    const token = generateToken(user);
    // Remove password from response
  const { password: userPassword, ...userWithoutPassword } = user;
  successResponse(res, { user: userWithoutPassword, token }, 'Login successful');
  } catch (error) {
    console.error('Login error:', error);
    errorResponse(res, 'Internal server error', 500);
  }
});

// Get current user profile
router.get('/profile', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const userResult = await pool.query('SELECT id, email, first_name, last_name, phone, role, created_at FROM users WHERE id = $1', [userId]);
    const user = userResult.rows[0];
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }
    successResponse(res, user, 'Profile retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Database error', 500);
  }
});

// Update user profile
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { firstName, lastName, phone } = req.body;
    if (!firstName || !lastName) {
      return errorResponse(res, 'First name and last name are required', 400);
    }
    const result = await pool.query(
      `UPDATE users SET first_name = $1, last_name = $2, phone = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4`,
      [firstName, lastName, phone, userId]
    );a
    if (result.rowCount === 0) {
      return errorResponse(res, 'User not found', 404);
    }
    successResponse(res, null, 'Profile updated successfully');
  } catch (error) {
    console.error('Profile update error:', error);
    errorResponse(res, 'Internal server error', 500);
  }
});

// Change password
router.put('/change-password', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return errorResponse(res, 'Current password and new password are required', 400);
    }
    if (newPassword.length < 6) {
      return errorResponse(res, 'New password must be at least 6 characters long', 400);
    }
    // Get current user
    const userResult = await pool.query('SELECT password FROM users WHERE id = $1', [userId]);
    const user = userResult.rows[0];
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }
    // Verify current password
    const isValidPassword = await comparePassword(currentPassword, user.password);
    if (!isValidPassword) {
      return errorResponse(res, 'Current password is incorrect', 401);
    }
    // Hash new password
    const hashedNewPassword = await hashPassword(newPassword);
    // Update password
    await pool.query('UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [hashedNewPassword, userId]);
    successResponse(res, null, 'Password updated successfully');
  } catch (error) {
    console.error('Password change error:', error);
    errorResponse(res, 'Internal server error', 500);
  }
});

module.exports = router;

