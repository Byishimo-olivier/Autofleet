const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/helpers');
const EmailService = require('../Service/EmailService'); // Add this import

// Submit feedback for a completed booking (ENHANCED with email notifications)
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

    // 🔍 Add comprehensive debugging
    console.log('=== FEEDBACK SUBMISSION DEBUG ===');
    console.log('Customer ID:', customerId);
    console.log('Raw request body:', JSON.stringify(req.body, null, 2));
    console.log('Extracted values:', {
      bookingId: bookingId,
      bookingIdType: typeof bookingId,
      rating: rating,
      ratingType: typeof rating,
      comment: comment,
      commentType: typeof comment,
      serviceRating: serviceRating,
      serviceRatingType: typeof serviceRating,
      vehicleConditionRating: vehicleConditionRating,
      vehicleConditionRatingType: typeof vehicleConditionRating
    });

    // Basic validation
    if (!bookingId || !rating) {
      console.log('❌ Missing required fields');
      console.log('bookingId present:', !!bookingId);
      console.log('rating present:', !!rating);
      return errorResponse(res, 'Booking ID and rating are required', 400);
    }

    // Convert to numbers if they're strings
    const numericRating = Number(rating);
    const numericServiceRating = serviceRating ? Number(serviceRating) : null;
    const numericVehicleConditionRating = vehicleConditionRating ? Number(vehicleConditionRating) : null;

    console.log('Converted numeric values:', {
      numericRating,
      numericServiceRating,
      numericVehicleConditionRating
    });

    if (isNaN(numericRating) || numericRating < 1 || numericRating > 5) {
      console.log('❌ Invalid rating:', numericRating);
      return errorResponse(res, 'Rating must be between 1 and 5', 400);
    }

    if (numericServiceRating !== null && (isNaN(numericServiceRating) || numericServiceRating < 1 || numericServiceRating > 5)) {
      console.log('❌ Invalid service rating:', numericServiceRating);
      return errorResponse(res, 'Service rating must be between 1 and 5', 400);
    }

    if (numericVehicleConditionRating !== null && (isNaN(numericVehicleConditionRating) || numericVehicleConditionRating < 1 || numericVehicleConditionRating > 5)) {
      console.log('❌ Invalid vehicle condition rating:', numericVehicleConditionRating);
      return errorResponse(res, 'Vehicle condition rating must be between 1 and 5', 400);
    }

    // Check if booking exists and belongs to the customer - GET ALL RELATED INFO
    console.log('🔍 Checking booking existence...');
    const bookingResult = await pool.query(
      `SELECT b.*, v.id as vehicle_id, v.make, v.model, v.year, v.license_plate, v.owner_id,
              u.first_name as customer_first_name, u.last_name as customer_last_name, u.email as customer_email,
              o.first_name as owner_first_name, o.last_name as owner_last_name, o.email as owner_email
       FROM bookings b 
       LEFT JOIN vehicles v ON b.vehicle_id = v.id 
       LEFT JOIN users u ON b.customer_id = u.id
       LEFT JOIN users o ON v.owner_id = o.id
       WHERE b.id = $1 AND b.customer_id = $2`,
      [bookingId, customerId]
    );

    console.log('Booking query result:', bookingResult.rows.length);
    
    const booking = bookingResult.rows[0];
    if (!booking) {
      console.log('❌ Booking not found or access denied');
      console.log('Searched for booking ID:', bookingId, 'with customer ID:', customerId);
      return errorResponse(res, 'Booking not found or access denied', 404);
    }

    console.log('✅ Booking found:', {
      id: booking.id,
      status: booking.status,
      customer_id: booking.customer_id,
      vehicle_id: booking.vehicle_id
    });

    // Remove the completed status requirement for testing
    // if (booking.status !== 'completed') {
    //   console.log('❌ Booking not completed, status:', booking.status);
    //   return errorResponse(res, 'Can only provide feedback for completed bookings', 400);
    // }

    // Check if feedback already exists
    console.log('🔍 Checking for existing feedback...');
    const existingFeedbackResult = await pool.query('SELECT id FROM feedback WHERE booking_id = $1', [bookingId]);
    
    if (existingFeedbackResult.rows.length > 0) {
      console.log('❌ Feedback already exists for booking:', bookingId);
      return errorResponse(res, 'Feedback already submitted for this booking', 409);
    }

    console.log('✅ No existing feedback found');

    // Insert feedback
    console.log('🔍 Inserting feedback...');
    const insertResult = await pool.query(
      `INSERT INTO feedback (booking_id, customer_id, vehicle_id, rating, comment, service_rating, vehicle_condition_rating, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP) RETURNING *`,
      [
        bookingId, 
        customerId, 
        booking.vehicle_id, 
        numericRating, 
        comment || null, 
        numericServiceRating, 
        numericVehicleConditionRating
      ]
    );

    const newFeedback = insertResult.rows[0];
    console.log('✅ Feedback created successfully:', newFeedback.id);

    // 📧 SEND EMAIL NOTIFICATIONS
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

      const feedbackData = {
        ...newFeedback,
        customer_name: `${customer.first_name} ${customer.last_name}`,
        vehicle_info: `${vehicle.make} ${vehicle.model} ${vehicle.year}`
      };

      // Send feedback thank you email to customer
      await EmailService.sendFeedbackThankYou(customer, feedbackData, vehicle, booking);

      // Send feedback notification to vehicle owner
      await EmailService.sendFeedbackNotificationToOwner(owner, feedbackData, vehicle, customer, booking);

      // Send feedback notification to admin (if rating is low)
      if (numericRating <= 2) {
        const adminEmails = process.env.ADMIN_EMAILS ? process.env.ADMIN_EMAILS.split(',') : ['admin@autofleet.com'];
        for (const email of adminEmails) {
          await EmailService.sendLowRatingAlert(email.trim(), feedbackData, vehicle, customer, owner, booking);
        }
      }

      console.log('✅ Feedback email notifications sent');
    } catch (emailError) {
      console.error('❌ Failed to send feedback email notifications:', emailError);
      // Don't fail the feedback submission if email fails
    }

    successResponse(res, { 
      feedbackId: newFeedback.id,
      feedback: newFeedback 
    }, 'Feedback submitted successfully');

  } catch (error) {
    console.error('❌ Submit feedback error:', error);
    console.error('Error stack:', error.stack);
    errorResponse(res, `Internal server error: ${error.message}`, 500);
  }
});

// Update feedback (ENHANCED with email notifications for significant changes)
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
    // Get current feedback with all related info
    const feedbackResult = await pool.query(
      `SELECT f.*, b.id as booking_id, v.make, v.model, v.year, v.license_plate, v.owner_id,
              u.first_name as customer_first_name, u.last_name as customer_last_name, u.email as customer_email,
              o.first_name as owner_first_name, o.last_name as owner_last_name, o.email as owner_email
       FROM feedback f
       LEFT JOIN bookings b ON f.booking_id = b.id
       LEFT JOIN vehicles v ON f.vehicle_id = v.id
       LEFT JOIN users u ON f.customer_id = u.id
       LEFT JOIN users o ON v.owner_id = o.id
       WHERE f.id = $1 AND f.customer_id = $2`,
      [feedbackId, customerId]
    );

    if (feedbackResult.rows.length === 0) {
      return errorResponse(res, 'Feedback not found or access denied', 404);
    }

    const currentFeedback = feedbackResult.rows[0];
    const oldRating = currentFeedback.rating;

    let updateFields = [];
    let params = [];
    let idx = 1;
    let significantChange = false;

    if (rating !== undefined) {
      updateFields.push(`rating = $${idx++}`);
      params.push(rating);
      // Check if rating changed significantly (2+ stars difference)
      if (Math.abs(rating - oldRating) >= 2) {
        significantChange = true;
      }
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

    // Add updated timestamp
    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    params.push(feedbackId);
    const sql = `UPDATE feedback SET ${updateFields.join(', ')} WHERE id = $${idx}`;
    await pool.query(sql, params);

    // 📧 SEND EMAIL NOTIFICATION FOR SIGNIFICANT CHANGES
    if (significantChange) {
      try {
        const owner = {
          first_name: currentFeedback.owner_first_name,
          last_name: currentFeedback.owner_last_name,
          email: currentFeedback.owner_email
        };

        const customer = {
          first_name: currentFeedback.customer_first_name,
          last_name: currentFeedback.customer_last_name,
          email: currentFeedback.customer_email
        };

        const vehicle = {
          make: currentFeedback.make,
          model: currentFeedback.model,
          year: currentFeedback.year,
          license_plate: currentFeedback.license_plate
        };

        const updatedFeedback = {
          ...currentFeedback,
          rating: rating || currentFeedback.rating,
          comment: comment !== undefined ? comment : currentFeedback.comment,
          old_rating: oldRating,
          new_rating: rating || currentFeedback.rating
        };

        // Notify owner of significant feedback change
        await EmailService.sendFeedbackUpdateNotification(owner, updatedFeedback, vehicle, customer);

        console.log('✅ Feedback update notification sent');
      } catch (emailError) {
        console.error('❌ Failed to send feedback update notification:', emailError);
      }
    }

    successResponse(res, null, 'Feedback updated successfully');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Failed to update feedback', 500);
  }
});

// Delete feedback (ENHANCED with email notification)
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  const feedbackId = req.params.id;

  try {
    // Get feedback details before deletion
    const feedbackResult = await pool.query(
      `SELECT f.*, v.make, v.model, v.year, v.license_plate, v.owner_id,
              u.first_name as customer_first_name, u.last_name as customer_last_name, u.email as customer_email,
              o.first_name as owner_first_name, o.last_name as owner_last_name, o.email as owner_email
       FROM feedback f
       LEFT JOIN vehicles v ON f.vehicle_id = v.id
       LEFT JOIN users u ON f.customer_id = u.id
       LEFT JOIN users o ON v.owner_id = o.id
       WHERE f.id = $1`,
      [feedbackId]
    );

    const feedback = feedbackResult.rows[0];
    if (!feedback) {
      return errorResponse(res, 'Feedback not found', 404);
    }

    // Delete feedback
    const result = await pool.query('DELETE FROM feedback WHERE id = $1', [feedbackId]);
    if (result.rowCount === 0) {
      return errorResponse(res, 'Feedback not found', 404);
    }

    // 📧 SEND DELETION NOTIFICATION EMAILS
    try {
      const customer = {
        first_name: feedback.customer_first_name,
        last_name: feedback.customer_last_name,
        email: feedback.customer_email
      };

      const owner = {
        first_name: feedback.owner_first_name,
        last_name: feedback.owner_last_name,
        email: feedback.owner_email
      };

      const vehicle = {
        make: feedback.make,
        model: feedback.model,
        year: feedback.year,
        license_plate: feedback.license_plate
      };

      // Notify customer that their feedback was removed
      await EmailService.sendFeedbackDeletionNotification(customer, feedback, vehicle);

      // Notify owner that feedback was removed
      await EmailService.sendFeedbackDeletionNotification(owner, feedback, vehicle);

      console.log('✅ Feedback deletion notifications sent');
    } catch (emailError) {
      console.error('❌ Failed to send feedback deletion notifications:', emailError);
    }

    successResponse(res, null, 'Feedback deleted successfully');
  } catch (err) {
    console.error('Database error:', err);
    return errorResponse(res, 'Failed to delete feedback', 500);
  }
});

// ADD NEW ROUTE: Send feedback reminder manually
router.post('/remind/:customerId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const customerId = req.params.customerId;

    // Get completed bookings without feedback
    const bookingsResult = await pool.query(
      `SELECT b.*, v.make, v.model, v.year, v.license_plate,
              u.first_name, u.last_name, u.email
       FROM bookings b
       LEFT JOIN vehicles v ON b.vehicle_id = v.id
       LEFT JOIN users u ON b.customer_id = u.id
       LEFT JOIN feedback f ON b.id = f.booking_id
       WHERE b.customer_id = $1 AND b.status = 'completed' AND f.id IS NULL
       ORDER BY b.end_date DESC
       LIMIT 5`,
      [customerId]
    );

    if (bookingsResult.rows.length === 0) {
      return errorResponse(res, 'No completed bookings without feedback found', 404);
    }

    const customer = {
      first_name: bookingsResult.rows[0].first_name,
      last_name: bookingsResult.rows[0].last_name,
      email: bookingsResult.rows[0].email
    };

    // Send reminder for each booking
    for (const booking of bookingsResult.rows) {
      const vehicle = {
        make: booking.make,
        model: booking.model,
        year: booking.year,
        license_plate: booking.license_plate
      };

      await EmailService.sendFeedbackReminder(booking, customer, vehicle);
    }

    successResponse(res, {
      remindersCount: bookingsResult.rows.length,
      customer: customer
    }, 'Feedback reminders sent successfully');
  } catch (err) {
    console.error('❌ Error sending feedback reminders:', err);
    errorResponse(res, 'Failed to send feedback reminders', 500);
  }
});

// ADD NEW ROUTE: Test feedback email notifications
router.post('/test-email', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { emailType = 'thank_you', email } = req.body;
    
    if (!email) {
      return errorResponse(res, 'Email address is required', 400);
    }

    const testCustomer = {
      first_name: 'Test',
      last_name: 'Customer',
      email: email
    };

    const testOwner = {
      first_name: 'Test',
      last_name: 'Owner',
      email: 'owner@test.com'
    };

    const testVehicle = {
      make: 'Toyota',
      model: 'Camry',
      year: 2022,
      license_plate: 'TEST-123'
    };

    const testFeedback = {
      id: 'TEST-123',
      rating: 5,
      comment: 'Great experience! The car was clean and well-maintained.',
      service_rating: 5,
      vehicle_condition_rating: 4,
      customer_name: 'Test Customer',
      vehicle_info: 'Toyota Camry 2022'
    };

    const testBooking = {
      id: 'TEST-BOOKING-123',
      start_date: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      end_date: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      total_amount: 150
    };

    let result;
    switch (emailType) {
      case 'thank_you':
        result = await EmailService.sendFeedbackThankYou(testCustomer, testFeedback, testVehicle, testBooking);
        break;
      case 'owner_notification':
        result = await EmailService.sendFeedbackNotificationToOwner(testOwner, testFeedback, testVehicle, testCustomer, testBooking);
        break;
      case 'low_rating_alert':
        testFeedback.rating = 2;
        result = await EmailService.sendLowRatingAlert(email, testFeedback, testVehicle, testCustomer, testOwner, testBooking);
        break;
      case 'reminder':
        result = await EmailService.sendFeedbackReminder(testBooking, testCustomer, testVehicle);
        break;
      default:
        result = await EmailService.sendEmail(email, 'Test Email - Feedback Service', '<h1>Test Email</h1><p>Feedback email service is working correctly!</p>');
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

