const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse, sendEmail } = require('../utils/helpers');

// Create notification
router.post('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userId, type, title, message } = req.body;
    if (!userId || !type || !title || !message) {
      return errorResponse(res, 'User ID, type, title, and message are required', 400);
    }
    if (!['booking', 'payment', 'reminder', 'system'].includes(type)) {
      return errorResponse(res, 'Invalid notification type', 400);
    }
    const userResult = await pool.query('SELECT id, email FROM users WHERE id = $1', [userId]);
    const user = userResult.rows[0];
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }
    try {
      const result = await pool.query(
        `INSERT INTO notifications (user_id, type, title, message) VALUES ($1, $2, $3, $4) RETURNING id`,
        [userId, type, title, message]
      );
      if (type === 'booking' || type === 'payment') {
        sendEmail(user.email, title, `
          <h2>${title}</h2>
          <p>${message}</p>
          <p>Best regards,<br>AutoFleet Hub Team</p>
        `).catch(err => {
          console.error('Email sending failed:', err);
        });
      }
      successResponse(res, { notificationId: result.rows[0].id }, 'Notification created successfully');
    } catch (err) {
      console.error('Database error:', err);
      return errorResponse(res, 'Failed to create notification', 500);
    }
  } catch (error) {
    console.error('Create notification error:', error);
    errorResponse(res, 'Internal server error', 500);
  }
});

// Get user notifications
router.get('/', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { page = 1, limit = 20, isRead, type } = req.query;
  const offset = (page - 1) * limit;
  let sql = 'SELECT * FROM notifications WHERE user_id = $1';
  let params = [userId];
  let idx = 2;
  if (isRead !== undefined) {
    sql += ` AND is_read = $${idx++}`;
    params.push(isRead === 'true');
  }
  if (type) {
    sql += ` AND type = $${idx++}`;
    params.push(type);
  }
  sql += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`;
  params.push(parseInt(limit), parseInt(offset));
  try {
    const notificationsResult = await pool.query(sql, params);
    const notifications = notificationsResult.rows;
    // Get total count
    let countSql = 'SELECT COUNT(*) as total FROM notifications WHERE user_id = $1';
    let countParams = [userId];
    let countIdx = 2;
    if (isRead !== undefined) {
      countSql += ` AND is_read = $${countIdx++}`;
      countParams.push(isRead === 'true');
    }
    if (type) {
      countSql += ` AND type = $${countIdx++}`;
      countParams.push(type);
    }
    const countResult = await pool.query(countSql, countParams);
    const total = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(total / limit);
    successResponse(res, {
      notifications,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalNotifications: total,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    }, 'Notifications retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Database error', 500);
  }
});

// Get unread notification count
router.get('/unread-count', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const result = await pool.query('SELECT COUNT(*) as count FROM notifications WHERE user_id = $1 AND is_read = FALSE', [userId]);
    successResponse(res, { unreadCount: result.rows[0].count }, 'Unread count retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Database error', 500);
  }
});

// Mark notification as read
router.put('/:id/read', authenticateToken, async (req, res) => {
  const notificationId = req.params.id;
  const userId = req.user.id;
  try {
    const result = await pool.query(
      'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2',
      [notificationId, userId]
    );
    if (result.rowCount === 0) {
      return errorResponse(res, 'Notification not found or access denied', 404);
    }
    successResponse(res, null, 'Notification marked as read');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Failed to mark notification as read', 500);
  }
});

// Mark all notifications as read
router.put('/mark-all-read', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const result = await pool.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE', [userId]);
    successResponse(res, { updatedCount: result.rowCount }, 'All notifications marked as read');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Failed to mark notifications as read', 500);
  }
});

// Delete notification
router.delete('/:id', authenticateToken, async (req, res) => {
  const notificationId = req.params.id;
  const userId = req.user.id;
  const userRole = req.user.role;
  let sql = 'DELETE FROM notifications WHERE id = $1';
  let params = [notificationId];
  if (userRole !== 'admin') {
    sql += ' AND user_id = $2';
    params.push(userId);
  }
  try {
    const result = await pool.query(sql, params);
    if (result.rowCount === 0) {
      return errorResponse(res, 'Notification not found or access denied', 404);
    }
    successResponse(res, null, 'Notification deleted successfully');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Failed to delete notification', 500);
  }
});

// Send bulk notifications (admin only)
router.post('/bulk', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userIds, type, title, message, sendEmail: shouldSendEmail = false } = req.body;
    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return errorResponse(res, 'User IDs array is required', 400);
    }
    if (!type || !title || !message) {
      return errorResponse(res, 'Type, title, and message are required', 400);
    }
    if (!['booking', 'payment', 'reminder', 'system'].includes(type)) {
      return errorResponse(res, 'Invalid notification type', 400);
    }
    let emails = [];
    if (shouldSendEmail) {
      const placeholders = userIds.map((_, i) => `$${i + 1}`).join(',');
      const emailResult = await pool.query(`SELECT email FROM users WHERE id IN (${placeholders})`, userIds);
      emails = emailResult.rows.map(u => u.email);
    }
    // Insert notifications
    const insertPromises = userIds.map(userId =>
      pool.query(
        'INSERT INTO notifications (user_id, type, title, message) VALUES ($1, $2, $3, $4) RETURNING id',
        [userId, type, title, message]
      ).then(result => result.rows[0].id)
    );
    const notificationIds = await Promise.all(insertPromises);
    // Send emails if requested
    if (shouldSendEmail && emails.length > 0) {
      const emailHtml = `
        <h2>${title}</h2>
        <p>${message}</p>
        <p>Best regards,<br>AutoFleet Hub Team</p>
      `;
      emails.forEach(email => {
        sendEmail(email, title, emailHtml).catch(err => {
          console.error('Email sending failed for', email, ':', err);
        });
      });
    }
    successResponse(res, {
      notificationIds,
      sentCount: notificationIds.length,
      emailsSent: shouldSendEmail ? emails.length : 0
    }, 'Bulk notifications sent successfully');
  } catch (error) {
    console.error('Bulk notification error:', error);
    errorResponse(res, 'Failed to send bulk notifications', 500);
  }
});

// Get notification statistics (admin only)
router.get('/stats', authenticateToken, requireAdmin, async (req, res) => {
  const { period = '30' } = req.query;
  try {
    const totalResult = await pool.query(
      `SELECT COUNT(*) as total FROM notifications WHERE created_at >= NOW() - INTERVAL '$1 days'`,
      [period]
    );
    const byTypeResult = await pool.query(
      `SELECT type, COUNT(*) as count FROM notifications WHERE created_at >= NOW() - INTERVAL '$1 days' GROUP BY type`,
      [period]
    );
    const unreadResult = await pool.query(
      `SELECT COUNT(*) as unread FROM notifications WHERE is_read = FALSE`
    );
    const activeUsersResult = await pool.query(
      `SELECT COUNT(DISTINCT user_id) as active_users FROM notifications WHERE created_at >= NOW() - INTERVAL '$1 days'`,
      [period]
    );
    const stats = {
      totalNotifications: totalResult.rows[0].total,
      notificationsByType: byTypeResult.rows,
      unreadNotifications: unreadResult.rows[0].unread,
      activeUsers: activeUsersResult.rows[0].active_users
    };
    successResponse(res, stats, 'Notification statistics retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Failed to retrieve notification statistics', 500);
  }
});

// Helper function to create automatic notifications
const createAutoNotification = async (userId, type, title, message) => {
  const result = await pool.query(
    'INSERT INTO notifications (user_id, type, title, message) VALUES ($1, $2, $3, $4) RETURNING id',
    [userId, type, title, message]
  );
  return result.rows[0].id;
};

// Booking-related notification helpers
router.post('/booking-created', authenticateToken, async (req, res) => {
  const { bookingId, customerId, ownerId } = req.body;
  if (!bookingId || !customerId || !ownerId) {
    return errorResponse(res, 'Booking ID, customer ID, and owner ID are required', 400);
  }
  try {
    await Promise.all([
      createAutoNotification(
        customerId,
        'booking',
        'Booking Created',
        `Your booking request #${bookingId} has been submitted and is pending confirmation.`
      ),
      createAutoNotification(
        ownerId,
        'booking',
        'New Booking Request',
        `You have received a new booking request #${bookingId}. Please review and confirm.`
      )
    ]);
    successResponse(res, null, 'Booking notifications created successfully');
  } catch (err) {
    console.error('Notification creation error:', err);
    errorResponse(res, 'Failed to create booking notifications', 500);
  }
});

router.post('/booking-confirmed', authenticateToken, async (req, res) => {
  const { bookingId, customerId } = req.body;
  if (!bookingId || !customerId) {
    return errorResponse(res, 'Booking ID and customer ID are required', 400);
  }
  try {
    await createAutoNotification(
      customerId,
      'booking',
      'Booking Confirmed',
      `Your booking #${bookingId} has been confirmed! Please proceed with payment to secure your reservation.`
    );
    successResponse(res, null, 'Booking confirmation notification created successfully');
  } catch (err) {
    console.error('Notification creation error:', err);
    errorResponse(res, 'Failed to create booking confirmation notification', 500);
  }
});

router.post('/payment-received', authenticateToken, async (req, res) => {
  const { bookingId, customerId, ownerId } = req.body;
  if (!bookingId || !customerId || !ownerId) {
    return errorResponse(res, 'Booking ID, customer ID, and owner ID are required', 400);
  }
  try {
    await Promise.all([
      createAutoNotification(
        customerId,
        'payment',
        'Payment Confirmed',
        `Your payment for booking #${bookingId} has been received. Your reservation is now active.`
      ),
      createAutoNotification(
        ownerId,
        'payment',
        'Payment Received',
        `Payment has been received for booking #${bookingId}. The vehicle is now reserved.`
      )
    ]);
    successResponse(res, null, 'Payment notifications created successfully');
  } catch (err) {
    console.error('Notification creation error:', err);
    errorResponse(res, 'Failed to create payment notifications', 500);
  }
});

module.exports = router;

