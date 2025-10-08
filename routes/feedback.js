const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/helpers');

// Submit feedback for a completed booking
router.post('/', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.id;
    const {
      bookingId,
      rating,
      comment,
      serviceRating,
      vehicleConditionRating
    } = req.body;
    if (!bookingId || !rating) {
      return errorResponse(res, 'Booking ID and rating are required', 400);
    }
    if (rating < 1 || rating > 5) {
      return errorResponse(res, 'Rating must be between 1 and 5', 400);
    }
    if (serviceRating && (serviceRating < 1 || serviceRating > 5)) {
      return errorResponse(res, 'Service rating must be between 1 and 5', 400);
    }
    if (vehicleConditionRating && (vehicleConditionRating < 1 || vehicleConditionRating > 5)) {
      return errorResponse(res, 'Vehicle condition rating must be between 1 and 5', 400);
    }
    // Check if booking exists and belongs to the customer
    const bookingResult = await pool.query(
      `SELECT b.*, v.id as vehicle_id FROM bookings b LEFT JOIN vehicles v ON b.vehicle_id = v.id WHERE b.id = $1 AND b.customer_id = $2`,
      [bookingId, customerId]
    );
    const booking = bookingResult.rows[0];
    if (!booking) {
      return errorResponse(res, 'Booking not found or access denied', 404);
    }
    if (booking.status !== 'completed') {
      return errorResponse(res, 'Can only provide feedback for completed bookings', 400);
    }
    // Check if feedback already exists
    const existingFeedbackResult = await pool.query('SELECT id FROM feedback WHERE booking_id = $1', [bookingId]);
    if (existingFeedbackResult.rows.length > 0) {
      return errorResponse(res, 'Feedback already submitted for this booking', 409);
    }
    // Insert feedback
    const insertResult = await pool.query(
      `INSERT INTO feedback (booking_id, customer_id, vehicle_id, rating, comment, service_rating, vehicle_condition_rating)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [bookingId, customerId, booking.vehicle_id, rating, comment, serviceRating, vehicleConditionRating]
    );
    successResponse(res, { feedbackId: insertResult.rows[0].id }, 'Feedback submitted successfully');
  } catch (error) {
    console.error('Submit feedback error:', error);
    errorResponse(res, 'Internal server error', 500);
  }
});

// Get all feedback with filtering
router.get('/', async (req, res) => {
  const {
    page = 1,
    limit = 10,
    vehicleId,
    customerId,
    minRating,
    maxRating,
    sortBy = 'created_at',
    sortOrder = 'DESC'
  } = req.query;
  const offset = (page - 1) * limit;
  let sql = `
    SELECT f.*, 
           u.first_name as customer_first_name, u.last_name as customer_last_name,
           v.make, v.model, v.year, v.license_plate,
           b.start_date, b.end_date
    FROM feedback f
    LEFT JOIN users u ON f.customer_id = u.id
    LEFT JOIN vehicles v ON f.vehicle_id = v.id
    LEFT JOIN bookings b ON f.booking_id = b.id
    WHERE 1=1`;
  let params = [];
  let idx = 1;
  if (vehicleId) {
    sql += ` AND f.vehicle_id = $${idx++}`;
    params.push(vehicleId);
  }
  if (customerId) {
    sql += ` AND f.customer_id = $${idx++}`;
    params.push(customerId);
  }
  if (minRating) {
    sql += ` AND f.rating >= $${idx++}`;
    params.push(parseInt(minRating));
  }
  if (maxRating) {
    sql += ` AND f.rating <= $${idx++}`;
    params.push(parseInt(maxRating));
  }
  const allowedSortFields = ['created_at', 'rating', 'service_rating', 'vehicle_condition_rating'];
  const validSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'created_at';
  const validSortOrder = ['ASC', 'DESC'].includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';
  sql += ` ORDER BY f.${validSortBy} ${validSortOrder} LIMIT $${idx++} OFFSET $${idx}`;
  params.push(parseInt(limit), parseInt(offset));
  try {
    const feedbackResult = await pool.query(sql, params);
    const feedback = feedbackResult.rows;
    // Get total count
    let countSql = 'SELECT COUNT(*) as total FROM feedback f WHERE 1=1';
    let countParams = [];
    let countIdx = 1;
    if (vehicleId) {
      countSql += ` AND f.vehicle_id = $${countIdx++}`;
      countParams.push(vehicleId);
    }
    if (customerId) {
      countSql += ` AND f.customer_id = $${countIdx++}`;
      countParams.push(customerId);
    }
    if (minRating) {
      countSql += ` AND f.rating >= $${countIdx++}`;
      countParams.push(parseInt(minRating));
    }
    if (maxRating) {
      countSql += ` AND f.rating <= $${countIdx++}`;
      countParams.push(parseInt(maxRating));
    }
    const countResult = await pool.query(countSql, countParams);
    const total = countResult.rows[0].total;
    const totalPages = Math.ceil(total / limit);
    successResponse(res, {
      feedback,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalFeedback: total,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    }, 'Feedback retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Database error', 500);
  }
});

// Get feedback by ID
router.get('/:id', async (req, res) => {
  const feedbackId = req.params.id;
  try {
    const result = await pool.query(
      `SELECT f.*, 
        u.first_name as customer_first_name, u.last_name as customer_last_name, u.email as customer_email,
        v.make, v.model, v.year, v.license_plate, v.type,
        b.start_date, b.end_date, b.total_amount
      FROM feedback f
      LEFT JOIN users u ON f.customer_id = u.id
      LEFT JOIN vehicles v ON f.vehicle_id = v.id
      LEFT JOIN bookings b ON f.booking_id = b.id
      WHERE f.id = $1`,
      [feedbackId]
    );
    const feedback = result.rows[0];
    if (!feedback) {
      return errorResponse(res, 'Feedback not found', 404);
    }
    successResponse(res, feedback, 'Feedback retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Database error', 500);
  }
});

// Get feedback for a specific vehicle
router.get('/vehicle/:vehicleId', async (req, res) => {
  const vehicleId = req.params.vehicleId;
  const { page = 1, limit = 10 } = req.query;
  const offset = (page - 1) * limit;
  try {
    const feedbackResult = await pool.query(
      `SELECT f.*, 
        u.first_name as customer_first_name, u.last_name as customer_last_name,
        b.start_date, b.end_date
      FROM feedback f
      LEFT JOIN users u ON f.customer_id = u.id
      LEFT JOIN bookings b ON f.booking_id = b.id
      WHERE f.vehicle_id = $1
      ORDER BY f.created_at DESC
      LIMIT $2 OFFSET $3`,
      [vehicleId, parseInt(limit), parseInt(offset)]
    );
    const feedback = feedbackResult.rows;
    const statsResult = await pool.query(
      `SELECT 
        COUNT(*) as total_reviews,
        AVG(rating) as average_rating,
        AVG(service_rating) as average_service_rating,
        AVG(vehicle_condition_rating) as average_condition_rating,
        SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) as five_star,
        SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) as four_star,
        SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) as three_star,
        SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) as two_star,
        SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) as one_star
      FROM feedback WHERE vehicle_id = $1`,
      [vehicleId]
    );
    const stats = statsResult.rows[0];
    const countResult = await pool.query('SELECT COUNT(*) as total FROM feedback WHERE vehicle_id = $1', [vehicleId]);
    const total = countResult.rows[0].total;
    const totalPages = Math.ceil(total / limit);
    successResponse(res, {
      feedback,
      statistics: {
        totalReviews: stats.total_reviews,
        averageRating: stats.average_rating ? parseFloat(Number(stats.average_rating).toFixed(2)) : 0,
        averageServiceRating: stats.average_service_rating ? parseFloat(Number(stats.average_service_rating).toFixed(2)) : 0,
        averageConditionRating: stats.average_condition_rating ? parseFloat(Number(stats.average_condition_rating).toFixed(2)) : 0,
        ratingDistribution: {
          fiveStar: stats.five_star,
          fourStar: stats.four_star,
          threeStar: stats.three_star,
          twoStar: stats.two_star,
          oneStar: stats.one_star
        }
      },
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalFeedback: total,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    }, 'Vehicle feedback retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Database error', 500);
  }
});

// Get feedback by customer
router.get('/customer/:customerId', authenticateToken, async (req, res) => {
  const customerId = req.params.customerId;
  const requestingUserId = req.user.id;
  const requestingUserRole = req.user.role;
  if (requestingUserRole !== 'admin' && parseInt(customerId) !== requestingUserId) {
    return errorResponse(res, 'Access denied', 403);
  }
  try {
    const result = await pool.query(
      `SELECT f.*, 
        v.make, v.model, v.year, v.license_plate,
        b.start_date, b.end_date
      FROM feedback f
      LEFT JOIN vehicles v ON f.vehicle_id = v.id
      LEFT JOIN bookings b ON f.booking_id = b.id
      WHERE f.customer_id = $1
      ORDER BY f.created_at DESC`,
      [customerId]
    );
    successResponse(res, result.rows, 'Customer feedback retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Database error', 500);
  }
});

// Update feedback (only by the customer who submitted it)
router.put('/:id', authenticateToken, async (req, res) => {
  const feedbackId = req.params.id;
  const customerId = req.user.id;
  const {
    rating,
    comment,
    serviceRating,
    vehicleConditionRating
  } = req.body;
  if (rating && (rating < 1 || rating > 5)) {
    return errorResponse(res, 'Rating must be between 1 and 5', 400);
  }
  if (serviceRating && (serviceRating < 1 || serviceRating > 5)) {
    return errorResponse(res, 'Service rating must be between 1 and 5', 400);
  }
  if (vehicleConditionRating && (vehicleConditionRating < 1 || vehicleConditionRating > 5)) {
    return errorResponse(res, 'Vehicle condition rating must be between 1 and 5', 400);
  }
  try {
    const feedbackResult = await pool.query('SELECT * FROM feedback WHERE id = $1 AND customer_id = $2', [feedbackId, customerId]);
    if (feedbackResult.rows.length === 0) {
      return errorResponse(res, 'Feedback not found or access denied', 404);
    }
    let updateFields = [];
    let params = [];
    let idx = 1;
    if (rating !== undefined) {
      updateFields.push(`rating = $${idx++}`);
      params.push(rating);
    }
    if (comment !== undefined) {
      updateFields.push(`comment = $${idx++}`);
      params.push(comment);
    }
    if (serviceRating !== undefined) {
      updateFields.push(`service_rating = $${idx++}`);
      params.push(serviceRating);
    }
    if (vehicleConditionRating !== undefined) {
      updateFields.push(`vehicle_condition_rating = $${idx++}`);
      params.push(vehicleConditionRating);
    }
    if (updateFields.length === 0) {
      return errorResponse(res, 'No fields to update', 400);
    }
    params.push(feedbackId);
    const sql = `UPDATE feedback SET ${updateFields.join(', ')} WHERE id = $${idx}`;
    await pool.query(sql, params);
    successResponse(res, null, 'Feedback updated successfully');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Failed to update feedback', 500);
  }
});

// Delete feedback (admin only)
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  const feedbackId = req.params.id;
  try {
    const result = await pool.query('DELETE FROM feedback WHERE id = $1', [feedbackId]);
    if (result.rowCount === 0) {
      return errorResponse(res, 'Feedback not found', 404);
    }
    successResponse(res, null, 'Feedback deleted successfully');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Failed to delete feedback', 500);
  }
});

// Get feedback statistics
router.get('/stats/overview', authenticateToken, async (req, res) => {
  const requestingUserRole = req.user.role;
  const requestingUserId = req.user.id;
  let baseCondition = '';
  let params = [];
  if (requestingUserRole === 'customer') {
    baseCondition = 'WHERE f.customer_id = $1';
    params = [requestingUserId];
  } else if (requestingUserRole === 'owner') {
    baseCondition = 'WHERE f.vehicle_id IN (SELECT id FROM vehicles WHERE owner_id = $1)';
    params = [requestingUserId];
  }
  try {
    const totalResult = await pool.query(`SELECT COUNT(*) as total FROM feedback f ${baseCondition}`, params);
    const avgRatingResult = await pool.query(`SELECT AVG(rating) as average_rating FROM feedback f ${baseCondition}`, params);
    const avgServiceResult = await pool.query(`SELECT AVG(service_rating) as average_service_rating FROM feedback f ${baseCondition}`, params);
    const avgConditionResult = await pool.query(`SELECT AVG(vehicle_condition_rating) as average_condition_rating FROM feedback f ${baseCondition}`, params);
    const recentResult = await pool.query(`SELECT COUNT(*) as recent FROM feedback f ${baseCondition} ${baseCondition ? 'AND' : 'WHERE'} f.created_at >= NOW() - INTERVAL '30 days'`, params);
    const stats = {
      totalFeedback: totalResult.rows[0].total,
      averageRating: avgRatingResult.rows[0].average_rating ? parseFloat(Number(avgRatingResult.rows[0].average_rating).toFixed(2)) : 0,
      averageServiceRating: avgServiceResult.rows[0].average_service_rating ? parseFloat(Number(avgServiceResult.rows[0].average_service_rating).toFixed(2)) : 0,
      averageConditionRating: avgConditionResult.rows[0].average_condition_rating ? parseFloat(Number(avgConditionResult.rows[0].average_condition_rating).toFixed(2)) : 0,
      recentFeedback: recentResult.rows[0].recent
    };
    successResponse(res, stats, 'Feedback statistics retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Failed to retrieve feedback statistics', 500);
  }
});

module.exports = router;

