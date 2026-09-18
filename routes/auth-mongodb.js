const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { connectMongo, toObjectId } = require('../config/mongodb');
const { hashPassword, comparePassword, validateEmail, successResponse, errorResponse } = require('../utils/helpers');
const { generateToken, authenticateToken } = require('../middleware/auth');
const EmailService = require('../Service/EmailService');

const emailService = new EmailService();

function publicUser(user) {
  if (!user) return null;
  const { password, reset_token, reset_expires, ...safeUser } = user;
  return {
    ...safeUser,
    id: user._id.toString(),
    firstName: user.first_name,
    lastName: user.last_name
  };
}

async function usersCollection() {
  const database = await connectMongo();
  return database.collection('users');
}

router.post('/register', async (req, res) => {
  try {
    const { email, password, firstName, lastName, phone, role = 'customer' } = req.body;
    const normalizedEmail = email?.toLowerCase();

    if (!email || !password || !firstName || !lastName) {
      return errorResponse(res, 'Email, password, first name, and last name are required', 400);
    }
    if (!validateEmail(email)) return errorResponse(res, 'Invalid email format', 400);
    if (password.length < 6) return errorResponse(res, 'Password must be at least 6 characters long', 400);

    const users = await usersCollection();
    if (await users.findOne({ email: normalizedEmail })) {
      return errorResponse(res, 'User with this email already exists', 409);
    }

    const now = new Date();
    const user = {
      email: normalizedEmail,
      password: await hashPassword(password),
      first_name: firstName,
      last_name: lastName,
      phone: phone || null,
      role,
      created_at: now,
      updated_at: now,
      last_login: null,
      reset_token: null,
      reset_expires: null
    };
    const result = await users.insertOne(user);
    user._id = result.insertedId;

    const responseUser = publicUser(user);
    const token = generateToken(responseUser);
    try {
      await emailService.sendWelcomeEmail(responseUser);
    } catch (emailError) {
      console.error('Failed to send welcome email:', emailError.message);
    }

    return successResponse(res, { user: responseUser, token }, 'User registered successfully');
  } catch (error) {
    console.error('Registration error:', error);
    return errorResponse(res, 'Internal server error', 500);
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return errorResponse(res, 'Email and password are required', 400);

    const users = await usersCollection();
    const user = await users.findOne({ email: email.toLowerCase() });
    if (!user || !(await comparePassword(password, user.password))) {
      return errorResponse(res, 'Invalid credentials', 401);
    }

    await users.updateOne({ _id: user._id }, { $set: { last_login: new Date(), updated_at: new Date() } });
    const responseUser = publicUser(user);
    return successResponse(res, { user: responseUser, token: generateToken(responseUser) }, 'Login successful');
  } catch (error) {
    console.error('Login error:', error);
    return errorResponse(res, 'Internal server error', 500);
  }
});

router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const user = await (await usersCollection()).findOne({ _id: toObjectId(req.user.id) });
    if (!user) return errorResponse(res, 'User not found', 404);
    return successResponse(res, publicUser(user), 'Profile retrieved successfully');
  } catch (error) {
    console.error('Profile error:', error);
    return errorResponse(res, 'Database error', 500);
  }
});

router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const { firstName, lastName, phone, email } = req.body;
    if (!firstName || !lastName) return errorResponse(res, 'First name and last name are required', 400);

    const users = await usersCollection();
    const userId = toObjectId(req.user.id);
    const currentUser = await users.findOne({ _id: userId });
    if (!currentUser) return errorResponse(res, 'User not found', 404);

    const normalizedEmail = email?.toLowerCase();
    if (normalizedEmail && normalizedEmail !== currentUser.email) {
      if (!validateEmail(normalizedEmail)) return errorResponse(res, 'Invalid email format', 400);
      if (await users.findOne({ email: normalizedEmail, _id: { $ne: userId } })) {
        return errorResponse(res, 'Email already in use by another account', 409);
      }
    }

    const changes = {
      first_name: firstName,
      last_name: lastName,
      phone: phone || null,
      updated_at: new Date()
    };
    if (normalizedEmail) changes.email = normalizedEmail;
    await users.updateOne({ _id: userId }, { $set: changes });
    const updatedUser = { ...currentUser, ...changes, _id: userId };

    try {
      await emailService.sendProfileUpdateConfirmation(updatedUser, currentUser);
    } catch (emailError) {
      console.error('Failed to send profile update email:', emailError.message);
    }
    return successResponse(res, publicUser(updatedUser), 'Profile updated successfully');
  } catch (error) {
    console.error('Profile update error:', error);
    return errorResponse(res, 'Internal server error', 500);
  }
});

router.put('/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return errorResponse(res, 'Current password and new password are required', 400);
    if (newPassword.length < 6) return errorResponse(res, 'New password must be at least 6 characters long', 400);

    const users = await usersCollection();
    const user = await users.findOne({ _id: toObjectId(req.user.id) });
    if (!user) return errorResponse(res, 'User not found', 404);
    if (!(await comparePassword(currentPassword, user.password))) return errorResponse(res, 'Current password is incorrect', 401);

    await users.updateOne({ _id: user._id }, { $set: { password: await hashPassword(newPassword), updated_at: new Date() } });
    return successResponse(res, null, 'Password updated successfully');
  } catch (error) {
    console.error('Password change error:', error);
    return errorResponse(res, 'Internal server error', 500);
  }
});

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !validateEmail(email)) return errorResponse(res, 'Invalid email format', 400);

    const users = await usersCollection();
    const user = await users.findOne({ email: email.toLowerCase() });
    if (user) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      await users.updateOne({ _id: user._id }, { $set: { reset_token: resetToken, reset_expires: new Date(Date.now() + 3600000) } });
      try { await emailService.sendPasswordResetEmail(user, resetToken); } catch (emailError) { console.error('Failed to send reset email:', emailError.message); }
    }
    return successResponse(res, null, 'If an account with that email exists, a password reset link has been sent');
  } catch (error) {
    console.error('Forgot password error:', error);
    return errorResponse(res, 'Internal server error', 500);
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return errorResponse(res, 'Token and new password are required', 400);
    if (newPassword.length < 6) return errorResponse(res, 'New password must be at least 6 characters long', 400);

    const users = await usersCollection();
    const user = await users.findOne({ reset_token: token, reset_expires: { $gt: new Date() } });
    if (!user) return errorResponse(res, 'Invalid or expired reset token', 400);
    await users.updateOne({ _id: user._id }, { $set: { password: await hashPassword(newPassword), updated_at: new Date() }, $unset: { reset_token: '', reset_expires: '' } });
    return successResponse(res, null, 'Password reset successfully');
  } catch (error) {
    console.error('Reset password error:', error);
    return errorResponse(res, 'Internal server error', 500);
  }
});

module.exports = router;
