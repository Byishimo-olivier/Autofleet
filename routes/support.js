const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/helpers');
const EmailService = require('../Service/EmailService'); // Add this import
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure upload directory exists
const uploadDir = 'uploads/support/';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'support-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Allow images and common document types
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|txt/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only images and documents are allowed.'));
    }
  }
});

// Get FAQ categories and questions
router.get('/faq', async (req, res) => {
  try {
    const { category } = req.query;

    let sql = `
      SELECT 
        f.id,
        f.question,
        f.answer,
        f.category,
        f.order_index,
        f.is_active,
        f.created_at,
        f.updated_at
      FROM faq f
      WHERE f.is_active = true
    `;
    
    let params = [];
    let paramIndex = 1;

    if (category) {
      sql += ` AND f.category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    sql += ` ORDER BY f.category, f.order_index ASC`;

    const result = await pool.query(sql, params);
    const faqs = result.rows;

    // Group FAQs by category
    const groupedFaqs = faqs.reduce((acc, faq) => {
      if (!acc[faq.category]) {
        acc[faq.category] = [];
      }
      acc[faq.category].push(faq);
      return acc;
    }, {});

    successResponse(res, {
      faqs: groupedFaqs,
      categories: Object.keys(groupedFaqs)
    }, 'FAQ retrieved successfully');

  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Failed to retrieve FAQ', 500);
  }
});

// Search FAQ
router.get('/faq/search', async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.trim().length < 3) {
      return errorResponse(res, 'Search query must be at least 3 characters long', 400);
    }

    const searchQuery = `%${q.trim()}%`;
    
    const result = await pool.query(
      `SELECT 
        id,
        question,
        answer,
        category,
        order_index
      FROM faq 
      WHERE is_active = true 
        AND (question ILIKE $1 OR answer ILIKE $1)
      ORDER BY 
        CASE 
          WHEN question ILIKE $1 THEN 1 
          ELSE 2 
        END,
        category, 
        order_index ASC
      LIMIT 20`,
      [searchQuery]
    );

    successResponse(res, result.rows, 'FAQ search completed');

  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Failed to search FAQ', 500);
  }
});

// Submit support request (ENHANCED with email notifications)
router.post('/requests', authenticateToken, upload.single('attachment'), async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      subject,
      description,
      booking_id,
      priority = 'medium',
      category
    } = req.body;

    console.log('=== SUPPORT REQUEST DEBUG ===');
    console.log('User ID:', userId);
    console.log('Request body:', req.body);
    console.log('File:', req.file);

    // Validation
    if (!subject || !description) {
      return errorResponse(res, 'Subject and description are required', 400);
    }

    if (description.length < 10) {
      return errorResponse(res, 'Description must be at least 10 characters long', 400);
    }

    // Fix category validation to match your frontend values
    const categoryMapping = {
      'payment': 'Payment Issue',
      'booking': 'Booking Issue', 
      'vehicle': 'Vehicle Issue',
      'account': 'Account Issue',
      'Booking Issue': 'Booking Issue',
      'Payment Issue': 'Payment Issue',
      'Vehicle Issue': 'Vehicle Issue',
      'Account Issue': 'Account Issue'
    };
    
    const requestCategory = categoryMapping[category] || 'Other';

    // Validate priority
    const validPriorities = ['low', 'medium', 'high', 'urgent'];
    const requestPriority = validPriorities.includes(priority) ? priority : 'medium';

    // Generate ticket ID
    const ticketPrefix = 'SUP';
    const timestamp = Date.now().toString().slice(-6);
    const ticketId = `${ticketPrefix}${timestamp}`;

    // Handle file attachment - fix path separator issue
    let attachmentPath = null;
    if (req.file) {
      // Normalize path separators for cross-platform compatibility
      attachmentPath = req.file.path.replace(/\\/g, '/');
    }

    // Validate booking_id if provided (convert to integer)
    let validBookingId = null;
    if (booking_id && booking_id.trim() !== '') {
      const bookingIdInt = parseInt(booking_id.replace(/[^\d]/g, ''), 10); // Remove non-digits
      if (!isNaN(bookingIdInt)) {
        const bookingResult = await pool.query(
          'SELECT id FROM bookings WHERE id = $1 AND customer_id = $2',
          [bookingIdInt, userId]
        );
        
        if (bookingResult.rows.length > 0) {
          validBookingId = bookingIdInt;
        }
      }
    }

    console.log('=== PROCESSED VALUES ===');
    console.log('Ticket ID:', ticketId);
    console.log('Category (original):', category);
    console.log('Category (mapped):', requestCategory);
    console.log('Priority:', requestPriority);
    console.log('Valid Booking ID:', validBookingId);
    console.log('Attachment Path:', attachmentPath);

    // Insert support request
    const insertResult = await pool.query(
      `INSERT INTO support_requests (
        ticket_id,
        user_id,
        subject,
        description,
        category,
        priority,
        booking_id,
        attachment_path,
        status,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING *`,
      [
        ticketId,
        userId,
        subject,
        description,
        requestCategory,
        requestPriority,
        validBookingId,
        attachmentPath,
        'open'
      ]
    );

    const newRequest = insertResult.rows[0];

    // Get complete request details with user info
    const completeRequestResult = await pool.query(
      `SELECT 
        sr.*,
        u.first_name,
        u.last_name,
        u.email,
        b.id as booking_reference
      FROM support_requests sr
      LEFT JOIN users u ON sr.user_id = u.id
      LEFT JOIN bookings b ON sr.booking_id = b.id
      WHERE sr.id = $1`,
      [newRequest.id]
    );

    const completeRequest = completeRequestResult.rows[0];

    // 📧 SEND EMAIL NOTIFICATIONS
    try {
      const customer = {
        first_name: completeRequest.first_name,
        last_name: completeRequest.last_name,
        email: completeRequest.email
      };

      const ticketData = {
        ...completeRequest,
        has_attachment: !!attachmentPath
      };

      // Send confirmation email to customer
      await EmailService.sendSupportTicketConfirmation(customer, ticketData);

      // Send notification to admin team
      const adminEmails = process.env.ADMIN_EMAILS ? process.env.ADMIN_EMAILS.split(',') : ['admin@autofleet.com'];
      for (const email of adminEmails) {
        await EmailService.sendSupportTicketNotification(email.trim(), ticketData, customer);
      }

      // If high priority, send urgent notification
      if (requestPriority === 'urgent' || requestPriority === 'high') {
        for (const email of adminEmails) {
          await EmailService.sendUrgentSupportAlert(email.trim(), ticketData, customer);
        }
      }

      console.log('✅ Support ticket email notifications sent');
    } catch (emailError) {
      console.error('❌ Failed to send support ticket email notifications:', emailError);
      // Don't fail the ticket creation if email fails
    }

    console.log('=== SUPPORT REQUEST CREATED ===');
    console.log('Database ID:', newRequest.id);
    console.log('Ticket ID:', ticketId);
    console.log('User ID:', userId);
    console.log('Subject:', subject);
    console.log('Category:', requestCategory);
    console.log('Priority:', requestPriority);

    successResponse(res, {
      supportRequest: completeRequest,
      ticketId: ticketId,
      message: 'Support request submitted successfully'
    }, 'Support request created successfully', 201);

  } catch (err) {
    console.error('Database error creating support request:', err);
    errorResponse(res, 'Failed to create support request', 500);
  }
});

// Get user's support requests
router.get('/requests', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const {
      page = 1,
      limit = 10,
      status,
      category,
      priority,
      sortBy = 'created_at',
      sortOrder = 'DESC'
    } = req.query;

    const offset = (page - 1) * limit;

    // Build query based on user role
    let sql = `
      SELECT 
        sr.*,
        u.first_name,
        u.last_name,
        u.email,
        b.id as booking_reference,
        COUNT(srr.id) as response_count
      FROM support_requests sr
      LEFT JOIN users u ON sr.user_id = u.id
      LEFT JOIN bookings b ON sr.booking_id = b.id
      LEFT JOIN support_request_responses srr ON sr.id = srr.request_id
      WHERE 1=1
    `;

    let params = [];
    let paramIndex = 1;

    // Role-based filtering
    if (userRole === 'customer') {
      sql += ` AND sr.user_id = $${paramIndex}`;
      params.push(parseInt(userId)); // Ensure integer
      paramIndex++;
    }

    // Status filter
    if (status) {
      sql += ` AND sr.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    // Category filter
    if (category) {
      sql += ` AND sr.category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    // Priority filter
    if (priority) {
      sql += ` AND sr.priority = $${paramIndex}`;
      params.push(priority);
      paramIndex++;
    }

    // Group by for count
    sql += ` GROUP BY sr.id, u.first_name, u.last_name, u.email, b.id`;

    // Sorting
    const allowedSortFields = ['created_at', 'updated_at', 'priority', 'status'];
    const validSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'created_at';
    const validSortOrder = ['ASC', 'DESC'].includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';

    sql += ` ORDER BY sr.${validSortBy} ${validSortOrder}`;
    sql += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const requestsResult = await pool.query(sql, params);
    const requests = requestsResult.rows;

    // Get total count
    let countSql = `
      SELECT COUNT(DISTINCT sr.id) as total 
      FROM support_requests sr 
      WHERE 1=1
    `;
    let countParams = [];
    let countParamIndex = 1;

    if (userRole === 'customer') {
      countSql += ` AND sr.user_id = $${countParamIndex}`;
      countParams.push(parseInt(userId)); // Ensure integer
      countParamIndex++;
    }

    if (status) {
      countSql += ` AND sr.status = $${countParamIndex}`;
      countParams.push(status);
      countParamIndex++;
    }

    if (category) {
      countSql += ` AND sr.category = $${countParamIndex}`;
      countParams.push(category);
      countParamIndex++;
    }

    if (priority) {
      countSql += ` AND sr.priority = $${countParamIndex}`;
      countParams.push(priority);
      countParamIndex++;
    }

    const countResult = await pool.query(countSql, countParams);
    const total = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(total / limit);

    successResponse(res, {
      requests,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalRequests: total,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    }, 'Support requests retrieved successfully');

  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Failed to retrieve support requests', 500);
  }
});

// Get support request by ID
router.get('/requests/:id', authenticateToken, async (req, res) => {
  try {
    const requestId = parseInt(req.params.id); // Ensure integer
    const userId = req.user.id;
    const userRole = req.user.role;

    if (isNaN(requestId)) {
      return errorResponse(res, 'Invalid request ID', 400);
    }

    // Get request with responses
    const requestResult = await pool.query(
      `SELECT 
        sr.*,
        u.first_name,
        u.last_name,
        u.email,
        b.id as booking_reference
      FROM support_requests sr
      LEFT JOIN users u ON sr.user_id = u.id
      LEFT JOIN bookings b ON sr.booking_id = b.id
      WHERE sr.id = $1`,
      [requestId]
    );

    if (requestResult.rows.length === 0) {
      return errorResponse(res, 'Support request not found', 404);
    }

    const request = requestResult.rows[0];

    // Check access permissions
    if (userRole === 'customer' && parseInt(request.user_id) !== parseInt(userId)) {
      return errorResponse(res, 'Access denied', 403);
    }

    // Get responses
    const responsesResult = await pool.query(
      `SELECT 
        srr.*,
        u.first_name as responder_first_name,
        u.last_name as responder_last_name,
        u.role as responder_role
      FROM support_request_responses srr
      LEFT JOIN users u ON srr.responder_id = u.id
      WHERE srr.request_id = $1
      ORDER BY srr.created_at ASC`,
      [requestId]
    );

    request.responses = responsesResult.rows;

    successResponse(res, request, 'Support request retrieved successfully');

  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Failed to retrieve support request', 500);
  }
});

// Add response to support request (ENHANCED with email notifications)
router.post('/requests/:id/responses', authenticateToken, async (req, res) => {
  try {
    const requestId = req.params.id;
    const userId = req.user.id;
    const userRole = req.user.role;
    const { message, is_internal = false } = req.body;

    if (!message || message.trim().length < 5) {
      return errorResponse(res, 'Response message must be at least 5 characters long', 400);
    }

    // Check if request exists and user has access - get complete info
    const requestResult = await pool.query(
      `SELECT sr.*, u.first_name, u.last_name, u.email
       FROM support_requests sr
       LEFT JOIN users u ON sr.user_id = u.id
       WHERE sr.id = $1`,
      [requestId]
    );

    if (requestResult.rows.length === 0) {
      return errorResponse(res, 'Support request not found', 404);
    }

    const request = requestResult.rows[0];

    // Check access permissions
    if (userRole === 'customer' && request.user_id !== userId) {
      return errorResponse(res, 'Access denied', 403);
    }

    // Only admins can make internal responses
    const responseIsInternal = userRole === 'admin' ? is_internal : false;

    // Add response
    const responseResult = await pool.query(
      `INSERT INTO support_request_responses (
        request_id,
        responder_id,
        message,
        is_internal,
        created_at
      ) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      RETURNING *`,
      [requestId, userId, message.trim(), responseIsInternal]
    );

    const newResponse = responseResult.rows[0];

    // Update request status and updated_at
    let newStatus = request.status;
    if (userRole === 'customer' && request.status === 'pending') {
      newStatus = 'waiting_for_support';
    } else if (userRole === 'admin' && request.status === 'waiting_for_support') {
      newStatus = 'pending';
    }

    await pool.query(
      'UPDATE support_requests SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newStatus, requestId]
    );

    // Get complete response details
    const completeResponseResult = await pool.query(
      `SELECT 
        srr.*,
        u.first_name as responder_first_name,
        u.last_name as responder_last_name,
        u.role as responder_role
      FROM support_request_responses srr
      LEFT JOIN users u ON srr.responder_id = u.id
      WHERE srr.id = $1`,
      [newResponse.id]
    );

    const completeResponse = completeResponseResult.rows[0];

    // 📧 SEND EMAIL NOTIFICATIONS
    try {
      if (!responseIsInternal) { // Don't send emails for internal responses
        const customer = {
          first_name: request.first_name,
          last_name: request.last_name,
          email: request.email
        };

        const responder = {
          first_name: completeResponse.responder_first_name,
          last_name: completeResponse.responder_last_name,
          role: completeResponse.responder_role
        };

        const ticketData = {
          ...request,
          response_message: message.trim(),
          responder_name: `${responder.first_name} ${responder.last_name}`,
          is_customer_response: userRole === 'customer'
        };

        if (userRole === 'admin') {
          // Admin responded to customer
          await EmailService.sendSupportResponseNotification(customer, ticketData, responder);
        } else {
          // Customer responded - notify admin team
          const adminEmails = process.env.ADMIN_EMAILS ? process.env.ADMIN_EMAILS.split(',') : ['admin@autofleet.com'];
          for (const email of adminEmails) {
            await EmailService.sendSupportCustomerResponse(email.trim(), ticketData, customer);
          }
        }

        console.log('✅ Support response email notifications sent');
      }
    } catch (emailError) {
      console.error('❌ Failed to send support response email notifications:', emailError);
      // Don't fail the response if email fails
    }

    successResponse(res, {
      response: completeResponse,
      newStatus: newStatus
    }, 'Response added successfully', 201);

  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Failed to add response', 500);
  }
});

// Update support request status (Admin only) - ENHANCED with email notifications
router.put('/requests/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const requestId = req.params.id;
    const { status, resolution_notes } = req.body;

    const validStatuses = ['open', 'pending', 'waiting_for_support', 'resolved', 'closed'];
    if (!validStatuses.includes(status)) {
      return errorResponse(res, 'Invalid status', 400);
    }

    // Check if request exists - get complete info
    const requestResult = await pool.query(
      `SELECT sr.*, u.first_name, u.last_name, u.email
       FROM support_requests sr
       LEFT JOIN users u ON sr.user_id = u.id
       WHERE sr.id = $1`,
      [requestId]
    );

    if (requestResult.rows.length === 0) {
      return errorResponse(res, 'Support request not found', 404);
    }

    const request = requestResult.rows[0];
    const oldStatus = request.status;

    // Update status
    const updateFields = ['status = $2', 'updated_at = CURRENT_TIMESTAMP'];
    const params = [requestId, status];
    let paramIndex = 3;

    if (resolution_notes && (status === 'resolved' || status === 'closed')) {
      updateFields.push(`resolution_notes = $${paramIndex}`);
      params.push(resolution_notes);
      paramIndex++;
    }

    if (status === 'resolved' || status === 'closed') {
      updateFields.push(`resolved_at = CURRENT_TIMESTAMP`);
    }

    const sql = `UPDATE support_requests SET ${updateFields.join(', ')} WHERE id = $1 RETURNING *`;
    
    const updateResult = await pool.query(sql, params);
    const updatedRequest = updateResult.rows[0];

    // 📧 SEND EMAIL NOTIFICATION FOR STATUS CHANGE
    try {
      const customer = {
        first_name: request.first_name,
        last_name: request.last_name,
        email: request.email
      };

      const ticketData = {
        ...updatedRequest,
        old_status: oldStatus,
        new_status: status
      };

      // Send status update notification to customer
      await EmailService.sendSupportStatusUpdate(customer, ticketData, resolution_notes);

      console.log('✅ Support status update email notification sent');
    } catch (emailError) {
      console.error('❌ Failed to send support status update email notification:', emailError);
      // Don't fail the status update if email fails
    }

    successResponse(res, updatedRequest, 'Support request status updated successfully');

  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Failed to update support request status', 500);
  }
});

// Get support statistics (Admin only)
router.get('/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // Get overall statistics
    const statsResult = await pool.query(`
      SELECT 
        COUNT(*) as total_requests,
        COUNT(CASE WHEN status = 'open' THEN 1 END) as open_requests,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_requests,
        COUNT(CASE WHEN status = 'waiting_for_support' THEN 1 END) as waiting_requests,
        COUNT(CASE WHEN status = 'resolved' THEN 1 END) as resolved_requests,
        COUNT(CASE WHEN status = 'closed' THEN 1 END) as closed_requests,
        COUNT(CASE WHEN priority = 'urgent' THEN 1 END) as urgent_requests,
        COUNT(CASE WHEN priority = 'high' THEN 1 END) as high_priority_requests
      FROM support_requests
      WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
    `);

    // Get category breakdown
    const categoryResult = await pool.query(`
      SELECT 
        category,
        COUNT(*) as request_count
      FROM support_requests
      WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY category
      ORDER BY request_count DESC
    `);

    // Get recent activity
    const recentResult = await pool.query(`
      SELECT 
        sr.ticket_id,
        sr.subject,
        sr.status,
        sr.priority,
        sr.created_at,
        u.first_name,
        u.last_name
      FROM support_requests sr
      LEFT JOIN users u ON sr.user_id = u.id
      ORDER BY sr.created_at DESC
      LIMIT 10
    `);

    const stats = statsResult.rows[0];
    const categoryBreakdown = categoryResult.rows;
    const recentActivity = recentResult.rows;

    successResponse(res, {
      overview: {
        totalRequests: parseInt(stats.total_requests),
        openRequests: parseInt(stats.open_requests),
        pendingRequests: parseInt(stats.pending_requests),
        waitingRequests: parseInt(stats.waiting_requests),
        resolvedRequests: parseInt(stats.resolved_requests),
        closedRequests: parseInt(stats.closed_requests),
        urgentRequests: parseInt(stats.urgent_requests),
        highPriorityRequests: parseInt(stats.high_priority_requests)
      },
      categoryBreakdown,
      recentActivity
    }, 'Support statistics retrieved successfully');

  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Failed to retrieve support statistics', 500);
  }
});

// Get all disputes (Admin only)
router.get('/disputes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      priority,
      sortBy = 'created_at',
      sortOrder = 'DESC'
    } = req.query;

    const offset = (page - 1) * limit;

    console.log('📋 Getting disputes list...');

    // Build query
    let sql = `
      SELECT 
        d.*,
        b.id as booking_reference,
        b.total_amount as booking_amount,
        customer.first_name as customer_first_name,
        customer.last_name as customer_last_name,
        customer.email as customer_email,
        owner.first_name as owner_first_name,
        owner.last_name as owner_last_name,
        owner.email as owner_email,
        v.make as vehicle_make,
        v.model as vehicle_model,
        v.year as vehicle_year
      FROM disputes d
      LEFT JOIN bookings b ON d.booking_id = b.id
      LEFT JOIN users customer ON d.customer_id = customer.id
      LEFT JOIN vehicles v ON b.vehicle_id = v.id
      LEFT JOIN users owner ON v.owner_id = owner.id
      WHERE 1=1
    `;

    let params = [];
    let paramIndex = 1;

    // Status filter
    if (status && status !== 'All Status') {
      sql += ` AND d.status = $${paramIndex}`;
      params.push(status.toLowerCase());
      paramIndex++;
    }

    // Priority filter
    if (priority && priority !== 'All Priority') {
      sql += ` AND d.priority = $${paramIndex}`;
      params.push(priority.toLowerCase());
      paramIndex++;
    }

    // Sorting
    const allowedSortFields = ['created_at', 'updated_at', 'priority', 'status'];
    const validSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'created_at';
    const validSortOrder = ['ASC', 'DESC'].includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';

    sql += ` ORDER BY d.${validSortBy} ${validSortOrder}`;
    sql += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const disputesResult = await pool.query(sql, params);
    const disputes = disputesResult.rows.map(dispute => ({
      id: `DSP-${dispute.id}`,
      bookingId: `#BK-${dispute.booking_reference}`,
      customer: {
        initials: `${dispute.customer_first_name?.charAt(0) || 'U'}${dispute.customer_last_name?.charAt(0) || 'U'}`,
        name: `${dispute.customer_first_name || 'Unknown'} ${dispute.customer_last_name || 'User'}`,
        email: dispute.customer_email
      },
      owner: `${dispute.owner_first_name || 'Unknown'} ${dispute.owner_last_name || 'Owner'}`,
      issue: dispute.description || dispute.reason || 'General dispute',
      status: dispute.status === 'open' ? 'Open' : 
              dispute.status === 'in_progress' ? 'In progress' : 
              dispute.status === 'resolved' ? 'Resolved' : 'Open',
      priority: dispute.priority === 'high' ? 'High' : 
                dispute.priority === 'medium' ? 'Medium' : 
                dispute.priority === 'low' ? 'Low' : 'Medium',
      created_at: dispute.created_at,
      vehicle: `${dispute.vehicle_make || ''} ${dispute.vehicle_model || ''} ${dispute.vehicle_year || ''}`.trim(),
      amount: dispute.booking_amount,
      actions: ["View", "Close"]
    }));

    // Get total count
    let countSql = `SELECT COUNT(*) as total FROM disputes d WHERE 1=1`;
    let countParams = [];
    let countParamIndex = 1;

    if (status && status !== 'All Status') {
      countSql += ` AND d.status = $${countParamIndex}`;
      countParams.push(status.toLowerCase());
      countParamIndex++;
    }

    if (priority && priority !== 'All Priority') {
      countSql += ` AND d.priority = $${countParamIndex}`;
      countParams.push(priority.toLowerCase());
      countParamIndex++;
    }

    const countResult = await pool.query(countSql, countParams);
    const total = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(total / limit);

    console.log(`📋 Found ${disputes.length} disputes`);

    successResponse(res, {
      disputes,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalDisputes: total,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    }, 'Disputes retrieved successfully');

  } catch (err) {
    console.error('❌ Error getting disputes:', err);
    errorResponse(res, 'Failed to retrieve disputes', 500);
  }
});

// Create new dispute (ENHANCED with email notifications)
router.post('/disputes', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      booking_id,
      reason,
      description,
      priority = 'medium'
    } = req.body;

    console.log('🆕 Creating new dispute...');

    // Validation
    if (!booking_id || !reason || !description) {
      return errorResponse(res, 'Booking ID, reason, and description are required', 400);
    }

    // Verify booking exists and user has access - get complete info
    const bookingResult = await pool.query(
      `SELECT b.*, v.make, v.model, v.year, v.license_plate, v.owner_id,
              customer.first_name as customer_first_name, customer.last_name as customer_last_name, customer.email as customer_email,
              owner.first_name as owner_first_name, owner.last_name as owner_last_name, owner.email as owner_email
       FROM bookings b
       LEFT JOIN vehicles v ON b.vehicle_id = v.id
       LEFT JOIN users customer ON b.customer_id = customer.id
       LEFT JOIN users owner ON v.owner_id = owner.id
       WHERE b.id = $1 AND b.customer_id = $2`,
      [booking_id, userId]
    );

    if (bookingResult.rows.length === 0) {
      return errorResponse(res, 'Booking not found or access denied', 404);
    }

    const booking = bookingResult.rows[0];

    // Check if dispute already exists for this booking
    const existingDispute = await pool.query(
      'SELECT id FROM disputes WHERE booking_id = $1',
      [booking_id]
    );

    if (existingDispute.rows.length > 0) {
      return errorResponse(res, 'Dispute already exists for this booking', 400);
    }

    // Create dispute
    const disputeResult = await pool.query(
      `INSERT INTO disputes (
        booking_id,
        customer_id,
        reason,
        description,
        priority,
        status,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING *`,
      [booking_id, userId, reason, description, priority, 'open']
    );

    const newDispute = disputeResult.rows[0];

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

      const disputeData = {
        ...newDispute,
        dispute_id: `DSP-${newDispute.id}`,
        booking_reference: `#BK-${booking.id}`
      };

      // Send confirmation to customer
      await EmailService.sendDisputeConfirmation(customer, disputeData, booking, vehicle);

      // Send notification to owner
      await EmailService.sendDisputeNotificationToOwner(owner, disputeData, booking, vehicle, customer);

      // Send notification to admin team
      const adminEmails = process.env.ADMIN_EMAILS ? process.env.ADMIN_EMAILS.split(',') : ['admin@autofleet.com'];
      for (const email of adminEmails) {
        await EmailService.sendDisputeAlert(email.trim(), disputeData, booking, vehicle, customer, owner);
      }

      console.log('✅ Dispute email notifications sent');
    } catch (emailError) {
      console.error('❌ Failed to send dispute email notifications:', emailError);
      // Don't fail the dispute creation if email fails
    }

    console.log('✅ Dispute created:', newDispute.id);

    successResponse(res, newDispute, 'Dispute created successfully', 201);

  } catch (err) {
    console.error('❌ Error creating dispute:', err);
    errorResponse(res, 'Failed to create dispute', 500);
  }
});

// Get dispute by ID
router.get('/disputes/:id', authenticateToken, async (req, res) => {
  try {
    const disputeId = req.params.id.replace('DSP-', ''); // Remove prefix if present
    const userId = req.user.id;
    const userRole = req.user.role;

    console.log('🔍 Getting dispute details:', disputeId);

    const disputeResult = await pool.query(
      `SELECT 
        d.*,
        b.id as booking_reference,
        b.total_amount as booking_amount,
        b.start_date,
        b.end_date,
        customer.first_name as customer_first_name,
        customer.last_name as customer_last_name,
        customer.email as customer_email,
        owner.first_name as owner_first_name,
        owner.last_name as owner_last_name,
        owner.email as owner_email,
        v.make as vehicle_make,
        v.model as vehicle_model,
        v.year as vehicle_year,
        v.license_plate
      FROM disputes d
      LEFT JOIN bookings b ON d.booking_id = b.id
      LEFT JOIN users customer ON d.customer_id = customer.id
      LEFT JOIN vehicles v ON b.vehicle_id = v.id
      LEFT JOIN users owner ON v.owner_id = owner.id
      WHERE d.id = $1`,
      [disputeId]
    );

    if (disputeResult.rows.length === 0) {
      return errorResponse(res, 'Dispute not found', 404);
    }

    const dispute = disputeResult.rows[0];

    // Check access permissions (customer can only see their own disputes)
    if (userRole === 'customer' && dispute.customer_id !== userId) {
      return errorResponse(res, 'Access denied', 403);
    }

    console.log('✅ Dispute found');

    successResponse(res, dispute, 'Dispute retrieved successfully');

  } catch (err) {
    console.error('❌ Error getting dispute:', err);
    errorResponse(res, 'Failed to retrieve dispute', 500);
  }
});

// Update dispute status (Admin only) - ENHANCED with email notifications
router.put('/disputes/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const disputeId = req.params.id.replace('DSP-', '');
    const { status, resolution_notes } = req.body;

    console.log('🔄 Updating dispute status:', disputeId, status);

    const validStatuses = ['open', 'in_progress', 'resolved', 'closed'];
    if (!validStatuses.includes(status)) {
      return errorResponse(res, 'Invalid status', 400);
    }

    // Get dispute details before update
    const disputeResult = await pool.query(
      `SELECT d.*, b.id as booking_reference, b.total_amount,
              customer.first_name as customer_first_name, customer.last_name as customer_last_name, customer.email as customer_email,
              owner.first_name as owner_first_name, owner.last_name as owner_last_name, owner.email as owner_email,
              v.make, v.model, v.year, v.license_plate
       FROM disputes d
       LEFT JOIN bookings b ON d.booking_id = b.id
       LEFT JOIN users customer ON d.customer_id = customer.id
       LEFT JOIN vehicles v ON b.vehicle_id = v.id
       LEFT JOIN users owner ON v.owner_id = owner.id
       WHERE d.id = $1`,
      [disputeId]
    );

    if (disputeResult.rows.length === 0) {
      return errorResponse(res, 'Dispute not found', 404);
    }

    const dispute = disputeResult.rows[0];
    const oldStatus = dispute.status;

    // Update dispute
    const updateFields = ['status = $2', 'updated_at = CURRENT_TIMESTAMP'];
    const params = [disputeId, status];
    let paramIndex = 3;

    if (resolution_notes && (status === 'resolved' || status === 'closed')) {
      updateFields.push(`resolution_notes = $${paramIndex}`);
      params.push(resolution_notes);
      paramIndex++;
    }

    if (status === 'resolved' || status === 'closed') {
      updateFields.push(`resolved_at = CURRENT_TIMESTAMP`);
    }

    const sql = `UPDATE disputes SET ${updateFields.join(', ')} WHERE id = $1 RETURNING *`;
    
    const updateResult = await pool.query(sql, params);

    // 📧 SEND EMAIL NOTIFICATIONS FOR STATUS CHANGE
    try {
      const customer = {
        first_name: dispute.customer_first_name,
        last_name: dispute.customer_last_name,
        email: dispute.customer_email
      };

      const owner = {
        first_name: dispute.owner_first_name,
        last_name: dispute.owner_last_name,
        email: dispute.owner_email
      };

      const vehicle = {
        make: dispute.make,
        model: dispute.model,
        year: dispute.year,
        license_plate: dispute.license_plate
      };

      const disputeData = {
        ...updateResult.rows[0],
        dispute_id: `DSP-${updateResult.rows[0].id}`,
        booking_reference: `#BK-${dispute.booking_reference}`,
        old_status: oldStatus,
        new_status: status
      };

      const booking = {
        id: dispute.booking_reference,
        total_amount: dispute.total_amount
      };

      // Send status update to customer
      await EmailService.sendDisputeStatusUpdate(customer, disputeData, booking, vehicle, resolution_notes);

      // Send status update to owner
      await EmailService.sendDisputeStatusUpdate(owner, disputeData, booking, vehicle, resolution_notes);

      console.log('✅ Dispute status update email notifications sent');
    } catch (emailError) {
      console.error('❌ Failed to send dispute status update email notifications:', emailError);
      // Don't fail the status update if email fails
    }

    console.log('✅ Dispute status updated');

    successResponse(res, updateResult.rows[0], 'Dispute status updated successfully');

  } catch (err) {
    console.error('❌ Error updating dispute status:', err);
    errorResponse(res, 'Failed to update dispute status', 500);
  }
});

// ADD NEW ROUTE: Test support email notifications
router.post('/test-email', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { emailType = 'ticket_confirmation', email } = req.body;
    
    if (!email) {
      return errorResponse(res, 'Email address is required', 400);
    }

    const testCustomer = {
      first_name: 'Test',
      last_name: 'Customer',
      email: email
    };

    const testTicket = {
      ticket_id: 'TEST-123456',
      subject: 'Test Support Ticket',
      description: 'This is a test support ticket for email notification testing.',
      category: 'Account Issue',
      priority: 'medium',
      status: 'open',
      has_attachment: false,
      created_at: new Date()
    };

    const testDispute = {
      id: 'TEST-DISPUTE-123',
      dispute_id: 'DSP-123',
      booking_reference: '#BK-789',
      reason: 'Test dispute reason',
      description: 'This is a test dispute for email notification testing.',
      priority: 'medium',
      status: 'open',
      created_at: new Date()
    };

    const testBooking = {
      id: 789,
      total_amount: 150,
      start_date: new Date(),
      end_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
    };

    const testVehicle = {
      make: 'Toyota',
      model: 'Camry',
      year: 2022,
      license_plate: 'TEST-123'
    };

    let result;
    switch (emailType) {
      case 'ticket_confirmation':
        result = await EmailService.sendSupportTicketConfirmation(testCustomer, testTicket);
        break;
      case 'ticket_notification':
        result = await EmailService.sendSupportTicketNotification(email, testTicket, testCustomer);
        break;
      case 'urgent_alert':
        testTicket.priority = 'urgent';
        result = await EmailService.sendUrgentSupportAlert(email, testTicket, testCustomer);
        break;
      case 'dispute_confirmation':
        result = await EmailService.sendDisputeConfirmation(testCustomer, testDispute, testBooking, testVehicle);
        break;
      case 'dispute_alert':
        result = await EmailService.sendDisputeAlert(email, testDispute, testBooking, testVehicle, testCustomer, testCustomer);
        break;
      default:
        result = await EmailService.sendEmail(email, 'Test Email - Support Service', '<h1>Test Email</h1><p>Support email service is working correctly!</p>');
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

// Get support tickets with enhanced formatting for frontend
router.get('/tickets', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const {
      page = 1,
      limit = 10,
      status,
      category,
      priority,
      sortBy = 'created_at',
      sortOrder = 'DESC'
    } = req.query;

    const offset = (page - 1) * limit;

    console.log('🎫 Getting support tickets...');

    // Build query based on user role
    let sql = `
      SELECT 
        sr.*,
        u.first_name,
        u.last_name,
        u.email,
        b.id as booking_reference,
        COUNT(srr.id) as response_count
      FROM support_requests sr
      LEFT JOIN users u ON sr.user_id = u.id
      LEFT JOIN bookings b ON sr.booking_id = b.id
      LEFT JOIN support_request_responses srr ON sr.id = srr.request_id
      WHERE 1=1
    `;

    let params = [];
    let paramIndex = 1;

    // Role-based filtering
    if (userRole === 'customer') {
      sql += ` AND sr.user_id = $${paramIndex}`;
      params.push(parseInt(userId));
      paramIndex++;
    }

    // Status filter
    if (status && status !== 'All Status') {
      sql += ` AND sr.status = $${paramIndex}`;
      params.push(status.toLowerCase().replace(' ', '_'));
      paramIndex++;
    }

    // Category filter
    if (category && category !== 'All Categories') {
      sql += ` AND sr.category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    // Priority filter
    if (priority && priority !== 'All Priority') {
      sql += ` AND sr.priority = $${paramIndex}`;
      params.push(priority.toLowerCase());
      paramIndex++;
    }

    // Group by for count
    sql += ` GROUP BY sr.id, u.first_name, u.last_name, u.email, b.id`;

    // Sorting
    const allowedSortFields = ['created_at', 'updated_at', 'priority', 'status'];
    const validSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'created_at';
    const validSortOrder = ['ASC', 'DESC'].includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';

    sql += ` ORDER BY sr.${validSortBy} ${validSortOrder}`;
    sql += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const ticketsResult = await pool.query(sql, params);
    const tickets = ticketsResult.rows.map(ticket => ({
      id: ticket.ticket_id || `TKT-${ticket.id}`,
      user: {
        initials: `${ticket.first_name?.charAt(0) || 'U'}${ticket.last_name?.charAt(0) || 'U'}`,
        name: `${ticket.first_name || 'Unknown'} ${ticket.last_name || 'User'}`,
        email: ticket.email
      },
      subject: ticket.subject,
      category: ticket.category,
      status: ticket.status === 'open' ? 'Open' : 
              ticket.status === 'pending' ? 'In Progress' : 
              ticket.status === 'resolved' ? 'Resolved' : 
              ticket.status === 'closed' ? 'Closed' : 'Open',
      priority: ticket.priority,
      created_at: ticket.created_at,
      response_count: parseInt(ticket.response_count || 0),
      actions: ["View", "Close"]
    }));

    // Get total count
    let countSql = `SELECT COUNT(DISTINCT sr.id) as total FROM support_requests sr WHERE 1=1`;
    let countParams = [];
    let countParamIndex = 1;

    if (userRole === 'customer') {
      countSql += ` AND sr.user_id = $${countParamIndex}`;
      countParams.push(parseInt(userId));
      countParamIndex++;
    }

    if (status && status !== 'All Status') {
      countSql += ` AND sr.status = $${countParamIndex}`;
      countParams.push(status.toLowerCase().replace(' ', '_'));
      countParamIndex++;
    }

    if (category && category !== 'All Categories') {
      countSql += ` AND sr.category = $${countParamIndex}`;
      countParams.push(category);
      countParamIndex++;
    }

    if (priority && priority !== 'All Priority') {
      countSql += ` AND sr.priority = $${countParamIndex}`;
      countParams.push(priority.toLowerCase());
      countParamIndex++;
    }

    const countResult = await pool.query(countSql, countParams);
    const total = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(total / limit);

    console.log(`🎫 Found ${tickets.length} tickets`);

    successResponse(res, {
      tickets,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalTickets: total,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    }, 'Support tickets retrieved successfully');

  } catch (err) {
    console.error('❌ Error getting support tickets:', err);
    errorResponse(res, 'Failed to retrieve support tickets', 500);
  }
});

// Create support ticket (enhanced version)
router.post('/tickets', authenticateToken, upload.single('attachment'), async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      subject,
      description,
      category,
      priority = 'medium',
      booking_id
    } = req.body;

    console.log('🎫 Creating support ticket...');

    // Enhanced validation
    if (!subject || subject.trim().length < 5) {
      return errorResponse(res, 'Subject must be at least 5 characters long', 400);
    }

    if (!description || description.trim().length < 10) {
      return errorResponse(res, 'Description must be at least 10 characters long', 400);
    }

    if (!category) {
      return errorResponse(res, 'Category is required', 400);
    }

    // Generate ticket ID
    const ticketPrefix = 'TKT';
    const timestamp = Date.now().toString().slice(-6);
    const ticketId = `${ticketPrefix}-${timestamp}`;

    // Handle file attachment
    let attachmentPath = null;
    if (req.file) {
      attachmentPath = req.file.path.replace(/\\/g, '/');
    }

    // Validate booking_id if provided
    let validBookingId = null;
    if (booking_id && booking_id.trim() !== '') {
      const bookingIdInt = parseInt(booking_id.replace(/[^\d]/g, ''), 10);
      if (!isNaN(bookingIdInt)) {
        const bookingResult = await pool.query(
          'SELECT id FROM bookings WHERE id = $1 AND customer_id = $2',
          [bookingIdInt, userId]
        );
        
        if (bookingResult.rows.length > 0) {
          validBookingId = bookingIdInt;
        }
      }
    }

    // Create ticket
    const ticketResult = await pool.query(
      `INSERT INTO support_requests (
        ticket_id,
        user_id,
        subject,
        description,
        category,
        priority,
        booking_id,
        attachment_path,
        status,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING *`,
      [
        ticketId,
        userId,
        subject.trim(),
        description.trim(),
        category,
        priority,
        validBookingId,
        attachmentPath,
        'open'
      ]
    );

    const newTicket = ticketResult.rows[0];

    console.log('✅ Support ticket created:', ticketId);

    successResponse(res, {
      ticket: newTicket,
      ticketId: ticketId
    }, 'Support ticket created successfully', 201);

  } catch (err) {
    console.error('❌ Error creating support ticket:', err);
    errorResponse(res, 'Failed to create support ticket', 500);
  }
});

// Get dispute and ticket statistics for dashboard
router.get('/dashboard-stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    console.log('📊 Getting support dashboard stats...');

    // Get dispute statistics
    const disputeStatsResult = await pool.query(`
      SELECT 
        COUNT(*) as total_disputes,
        COUNT(CASE WHEN status = 'open' THEN 1 END) as open_disputes,
        COUNT(CASE WHEN status = 'in_progress' THEN 1 END) as in_progress_disputes,
        COUNT(CASE WHEN status = 'resolved' THEN 1 END) as resolved_disputes,
        COUNT(CASE WHEN priority = 'high' THEN 1 END) as high_priority_disputes
      FROM disputes
      WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
    `);

    // Get ticket statistics
    const ticketStatsResult = await pool.query(`
      SELECT 
        COUNT(*) as total_tickets,
        COUNT(CASE WHEN status = 'open' THEN 1 END) as open_tickets,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_tickets,
        COUNT(CASE WHEN status = 'resolved' THEN 1 END) as resolved_tickets,
        COUNT(CASE WHEN priority = 'urgent' THEN 1 END) as urgent_tickets
      FROM support_requests
      WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
    `);

    const disputeStats = disputeStatsResult.rows[0];
    const ticketStats = ticketStatsResult.rows[0];

    const stats = {
      disputes: {
        total: parseInt(disputeStats.total_disputes),
        open: parseInt(disputeStats.open_disputes),
        inProgress: parseInt(disputeStats.in_progress_disputes),
        resolved: parseInt(disputeStats.resolved_disputes),
        highPriority: parseInt(disputeStats.high_priority_disputes)
      },
      tickets: {
        total: parseInt(ticketStats.total_tickets),
        open: parseInt(ticketStats.open_tickets),
        pending: parseInt(ticketStats.pending_tickets),
        resolved: parseInt(ticketStats.resolved_tickets),
        urgent: parseInt(ticketStats.urgent_tickets)
      }
    };

    console.log('📊 Support stats calculated');

    successResponse(res, stats, 'Support dashboard statistics retrieved successfully');

  } catch (err) {
    console.error('❌ Error getting support dashboard stats:', err);
    errorResponse(res, 'Failed to retrieve support dashboard statistics', 500);
  }
});

// Close dispute or ticket
router.put('/close/:type/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { type, id } = req.params; // type: 'dispute' or 'ticket'
    const { resolution_notes } = req.body;

    console.log(`🔒 Closing ${type}:`, id);

    let sql, params;
    const cleanId = id.replace(/^(DSP-|TKT-)/, ''); // Remove prefixes

    if (type === 'dispute') {
      sql = `UPDATE disputes SET 
             status = 'closed', 
             resolution_notes = $2, 
             resolved_at = CURRENT_TIMESTAMP, 
             updated_at = CURRENT_TIMESTAMP 
             WHERE id = $1 RETURNING *`;
      params = [cleanId, resolution_notes || 'Closed by admin'];
    } else if (type === 'ticket') {
      sql = `UPDATE support_requests SET 
             status = 'closed', 
             resolution_notes = $2, 
             resolved_at = CURRENT_TIMESTAMP, 
             updated_at = CURRENT_TIMESTAMP 
             WHERE id = $1 RETURNING *`;
      params = [cleanId, resolution_notes || 'Closed by admin'];
    } else {
      return errorResponse(res, 'Invalid type. Must be "dispute" or "ticket"', 400);
    }

    const result = await pool.query(sql, params);

    if (result.rows.length === 0) {
      return errorResponse(res, `${type.charAt(0).toUpperCase() + type.slice(1)} not found`, 404);
    }

    console.log(`✅ ${type} closed successfully`);

    successResponse(res, result.rows[0], `${type.charAt(0).toUpperCase() + type.slice(1)} closed successfully`);

  } catch (err) {
    console.error(`❌ Error closing ${type}:`, err);
    errorResponse(res, `Failed to close ${type}`, 500);
  }
});

module.exports = router;