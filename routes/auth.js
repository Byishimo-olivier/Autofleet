const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { hashPassword, comparePassword, validateEmail, successResponse, errorResponse } = require('../utils/helpers');
const { generateToken, authenticateToken } = require('../middleware/auth');
const EmailService = require('../Service/EmailService'); // Add this import

// Register new user (ENHANCED with welcome email)
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

    // 📧 SEND WELCOME EMAIL
    try {
      await EmailService.sendWelcomeEmail(user);
      console.log('✅ Welcome email sent to new user:', email);
    } catch (emailError) {
      console.error('❌ Failed to send welcome email:', emailError);
      // Don't fail registration if email fails
    }

    successResponse(res, { user, token }, 'User registered successfully');
  } catch (error) {
    console.error('Registration error:', error);
    errorResponse(res, 'Internal server error', 500);
  }
});

// Login user (ENHANCED with login notification option)
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return errorResponse(res, 'Email and password are required', 400);
    }

    // Find user by email
    const userResult = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (userResult.rows.length === 0) {
      return errorResponse(res, 'Invalid credentials', 401);
    }



    const user = userResult.rows[0];

    // Verify password
    const validPassword = await comparePassword(password, user.password);
    if (!validPassword) {
      return errorResponse(res, 'Invalid credentials', 401);
    }

    // Check if last_login column exists, if not, skip the update
    try {
      // Try to update last_login
      await pool.query(
        'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
        [user.id]
      );
    } catch (updateError) {
      // If column doesn't exist, log it but don't fail the login
      if (updateError.code === '42703') {
        console.log('⚠️ last_login column not found, skipping update');
      } else {
        console.error('Error updating last_login:', updateError);
      }
    }

    // Generate JWT token
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

// Update user profile (ENHANCED with significant change notifications)
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { firstName, lastName, phone, email } = req.body;

    if (!firstName || !lastName) {
      return errorResponse(res, 'First name and last name are required', 400);
    }

    // Get current user data
    const currentUserResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const currentUser = currentUserResult.rows[0];

    if (!currentUser) {
      return errorResponse(res, 'User not found', 404);
    }

    let updateFields = [];
    let params = [];
    let paramCount = 0;
    let emailChanged = false;

    // Build dynamic update query
    if (firstName !== currentUser.first_name) {
      paramCount++;
      updateFields.push(`first_name = $${paramCount}`);
      params.push(firstName);
    }

    if (lastName !== currentUser.last_name) {
      paramCount++;
      updateFields.push(`last_name = $${paramCount}`);
      params.push(lastName);
    }

    if (phone !== currentUser.phone) {
      paramCount++;
      updateFields.push(`phone = $${paramCount}`);
      params.push(phone);
    }

    // Handle email change (if provided and different)
    if (email && email !== currentUser.email) {
      if (!validateEmail(email)) {
        return errorResponse(res, 'Invalid email format', 400);
      }

      // Check if new email already exists
      const emailExistsResult = await pool.query('SELECT id FROM users WHERE email = $1 AND id != $2', [email, userId]);
      if (emailExistsResult.rows.length > 0) {
        return errorResponse(res, 'Email already in use by another account', 409);
      }

      paramCount++;
      updateFields.push(`email = $${paramCount}`);
      params.push(email);
      emailChanged = true;
    }

    if (updateFields.length === 0) {
      return errorResponse(res, 'No changes detected', 400);
    }

    // Add updated_at
    updateFields.push('updated_at = CURRENT_TIMESTAMP');

    // Execute update
    paramCount++;
    const sql = `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${paramCount}`;
    params.push(userId);

    const result = await pool.query(sql, params);

    if (result.rowCount === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    // 📧 SEND EMAIL NOTIFICATIONS
    try {
      const updatedUser = {
        ...currentUser,
        first_name: firstName,
        last_name: lastName,
        phone: phone || currentUser.phone,
        email: email || currentUser.email
      };

      // Send profile update confirmation
      await EmailService.sendProfileUpdateConfirmation(updatedUser, currentUser);

      // If email changed, send notification to both old and new email
      if (emailChanged) {
        await EmailService.sendEmailChangeNotification(currentUser.email, email, updatedUser);
      }

      console.log('✅ Profile update email notifications sent');
    } catch (emailError) {
      console.error('❌ Failed to send profile update notifications:', emailError);
    }

    successResponse(res, null, 'Profile updated successfully');
  } catch (error) {
    console.error('Profile update error:', error);
    errorResponse(res, 'Internal server error', 500);
  }
});

// Change password (ENHANCED with email notification)
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
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
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

    // 📧 SEND PASSWORD CHANGE NOTIFICATION
    try {
      await EmailService.sendPasswordChangeNotification(user);
      console.log('✅ Password change notification sent to user:', user.email);
    } catch (emailError) {
      console.error('❌ Failed to send password change notification:', emailError);
    }

    successResponse(res, null, 'Password updated successfully');
  } catch (error) {
    console.error('Password change error:', error);
    errorResponse(res, 'Internal server error', 500);
  }
});

// ADD NEW ROUTE: Request password reset
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return errorResponse(res, 'Email is required', 400);
    }

    if (!validateEmail(email)) {
      return errorResponse(res, 'Invalid email format', 400);
    }

    // Check if user exists
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = userResult.rows[0];

    // Always return success to prevent email enumeration
    if (!user) {
      return successResponse(res, null, 'If an account with that email exists, a password reset link has been sent');
    }

    // Generate reset token (you might want to store this in a separate table with expiration)
    const resetToken = require('crypto').randomBytes(32).toString('hex');
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

    // Store reset token (you'll need to add these columns to your users table)
    await pool.query(
      'UPDATE users SET reset_token = $1, reset_expires = $2 WHERE id = $3',
      [resetToken, resetExpires, user.id]
    );

    // 📧 SEND PASSWORD RESET EMAIL
    try {
      await EmailService.sendPasswordResetEmail(user, resetToken);
      console.log('✅ Password reset email sent to user:', email);
    } catch (emailError) {
      console.error('❌ Failed to send password reset email:', emailError);
    }

    successResponse(res, null, 'If an account with that email exists, a password reset link has been sent');
  } catch (error) {
    console.error('Forgot password error:', error);
    errorResponse(res, 'Internal server error', 500);
  }
});

// ADD NEW ROUTE: Reset password with token
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return errorResponse(res, 'Token and new password are required', 400);
    }

    if (newPassword.length < 6) {
      return errorResponse(res, 'New password must be at least 6 characters long', 400);
    }

    // Find user with valid reset token
    const userResult = await pool.query(
      'SELECT * FROM users WHERE reset_token = $1 AND reset_expires > NOW()',
      [token]
    );
    const user = userResult.rows[0];

    if (!user) {
      return errorResponse(res, 'Invalid or expired reset token', 400);
    }

    // Hash new password
    const hashedPassword = await hashPassword(newPassword);

    // Update password and clear reset token
    await pool.query(
      'UPDATE users SET password = $1, reset_token = NULL, reset_expires = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [hashedPassword, user.id]
    );

    // 📧 SEND PASSWORD RESET CONFIRMATION
    try {
      await EmailService.sendPasswordResetConfirmation(user);
      console.log('✅ Password reset confirmation sent to user:', user.email);
    } catch (emailError) {
      console.error('❌ Failed to send password reset confirmation:', emailError);
    }

    successResponse(res, null, 'Password reset successfully');
  } catch (error) {
    console.error('Reset password error:', error);
    errorResponse(res, 'Internal server error', 500);
  }
});

// ADD NEW ROUTE: Resend welcome email
router.post('/resend-welcome', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userResult.rows[0];

    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    // 📧 RESEND WELCOME EMAIL
    try {
      await EmailService.sendWelcomeEmail(user);
      console.log('✅ Welcome email resent to user:', user.email);
      successResponse(res, null, 'Welcome email sent successfully');
    } catch (emailError) {
      console.error('❌ Failed to resend welcome email:', emailError);
      errorResponse(res, 'Failed to send welcome email', 500);
    }
  } catch (error) {
    console.error('Resend welcome email error:', error);
    errorResponse(res, 'Internal server error', 500);
  }
});

// ADD NEW ROUTE: Test email service
router.post('/test-email', authenticateToken, async (req, res) => {
  try {
    const { emailType = 'test' } = req.body;
    const user = req.user;

    let result;
    switch (emailType) {
      case 'welcome':
        result = await EmailService.sendWelcomeEmail(user);
        break;
      case 'login':
        result = await EmailService.sendLoginNotification(user);
        break;
      case 'password_change':
        result = await EmailService.sendPasswordChangeNotification(user);
        break;
      default:
        result = await EmailService.sendEmail(user.email, 'Test Email - AutoFleet Hub', '<h1>Test Email</h1><p>Auth email service is working correctly!</p>');
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

module.exports = router;

