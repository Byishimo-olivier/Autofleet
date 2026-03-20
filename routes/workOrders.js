const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/helpers');

// --- TEMPLATES ---

// Get all templates
router.get('/templates', authenticateToken, async (req, res) => {
  try {
    const sql = `
      SELECT t.*, 
             CONCAT(v.first_name, ' ', v.last_name) AS vendor_name,
             CONCAT(c.first_name, ' ', c.last_name) AS customer_name
      FROM work_order_templates t
      LEFT JOIN users v ON t.vendor_id = v.id
      LEFT JOIN users c ON t.customer_id = c.id
      ORDER BY t.title ASC
    `;
    const result = await pool.query(sql);
    successResponse(res, result.rows, 'Templates retrieved successfully');
  } catch (err) {
    console.error('Error fetching templates:', err);
    errorResponse(res, 'Failed to fetch templates', 500);
  }
});

// Create a template
router.post('/templates', authenticateToken, async (req, res) => {
  try {
    const { title, description, location, vendor_id, customer_id } = req.body;
    if (!title) return errorResponse(res, 'Title is required', 400);

    const sql = `
      INSERT INTO work_order_templates (title, description, location, vendor_id, customer_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    const result = await pool.query(sql, [title, description, location, vendor_id || null, customer_id || null]);
    successResponse(res, result.rows[0], 'Template created successfully', 201);
  } catch (err) {
    console.error('Error creating template:', err);
    errorResponse(res, 'Failed to create template', 500);
  }
});

// Update a template
router.put('/templates/:id', authenticateToken, async (req, res) => {
  try {
    const { title, description, location, vendor_id, customer_id } = req.body;
    const sql = `
      UPDATE work_order_templates 
      SET title = COALESCE($1, title), 
          description = COALESCE($2, description), 
          location = COALESCE($3, location),
          vendor_id = COALESCE($4, vendor_id),
          customer_id = COALESCE($5, customer_id),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING *
    `;
    const result = await pool.query(sql, [title, description, location, vendor_id, customer_id, req.params.id]);
    if (result.rows.length === 0) return errorResponse(res, 'Template not found', 404);
    successResponse(res, result.rows[0], 'Template updated successfully');
  } catch (err) {
    console.error('Error updating template:', err);
    errorResponse(res, 'Failed to update template', 500);
  }
});

// Delete a template
router.delete('/templates/:id', authenticateToken, async (req, res) => {
  try {
    const sql = `DELETE FROM work_order_templates WHERE id = $1 RETURNING id`;
    const result = await pool.query(sql, [req.params.id]);
    if (result.rows.length === 0) return errorResponse(res, 'Template not found', 404);
    successResponse(res, null, 'Template deleted successfully');
  } catch (err) {
    console.error('Error deleting template:', err);
    errorResponse(res, 'Failed to delete template', 500);
  }
});

// --- WORK ORDERS ---

// Get all work orders (with filtering)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { status, priority, assignee, vendor, customer, day, location, search } = req.query;

    let sql = `
      SELECT w.*, 
             CONCAT(u.first_name, ' ', u.last_name) AS assignee_name, 
             u.email AS assignee_email,
             CONCAT(v_user.first_name, ' ', v_user.last_name) AS vendor_name,
             CONCAT(c_user.first_name, ' ', c_user.last_name) AS customer_name,
             v.make, v.model, v.license_plate
      FROM work_orders w
      LEFT JOIN users u ON w.assignee_id = u.id
      LEFT JOIN users v_user ON w.vendor_id = v_user.id
      LEFT JOIN users c_user ON w.customer_id = c_user.id
      LEFT JOIN vehicles v ON w.vehicle_id = v.id
      WHERE 1=1
    `;
    let params = [];
    let paramCount = 0;

    if (status) {
      // Split by comma if multiple statuses are requested
      const statuses = status.split(',');
      if (statuses.length > 1) {
        const placeholders = statuses.map(s => {
          paramCount++;
          params.push(s);
          return `$${paramCount}`;
        }).join(',');
        sql += ` AND w.status IN (${placeholders})`;
      } else {
        paramCount++;
        sql += ` AND w.status = $${paramCount}`;
        params.push(status);
      }
    }

    if (priority) {
      paramCount++;
      sql += ` AND w.priority = $${paramCount}`;
      params.push(priority);
    }

    if (assignee) {
      paramCount++;
      sql += ` AND w.assignee_id = $${paramCount}`;
      params.push(assignee);
    }

    if (day) {
      // Expecting day in YYYY-MM-DD format
      paramCount++;
      sql += ` AND DATE(COALESCE(w.due_date, w.created_at)) = $${paramCount}`;
      params.push(day);
    }

    if (location) {
      paramCount++;
      sql += ` AND w.location ILIKE $${paramCount}`;
      params.push(`%${location}%`);
    }

    if (search) {
      paramCount++;
      sql += ` AND (w.title ILIKE $${paramCount} OR w.id::text ILIKE $${paramCount})`;
      params.push(`%${search}%`);
    }

    if (vendor) {
      paramCount++;
      sql += ` AND w.vendor_id = $${paramCount}`;
      params.push(vendor);
    }

    if (customer) {
      paramCount++;
      sql += ` AND w.customer_id = $${paramCount}`;
      params.push(customer);
    }

    sql += ` ORDER BY COALESCE(w.due_date, w.created_at) ASC, w.id DESC`;

    const result = await pool.query(sql, params);
    successResponse(res, result.rows, 'Work orders retrieved successfully');
  } catch (err) {
    console.error('Error fetching work orders:', err);
    errorResponse(res, 'Failed to fetch work orders', 500);
  }
});

// Get a single work order
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const sql = `
      SELECT w.*, 
             CONCAT(u.first_name, ' ', u.last_name) AS assignee_name, 
             u.email AS assignee_email,
             CONCAT(v_user.first_name, ' ', v_user.last_name) AS vendor_name,
             v_user.email AS vendor_email,
             CONCAT(c_user.first_name, ' ', c_user.last_name) AS customer_name,
             c_user.email AS customer_email,
             v.make, v.model, v.license_plate, v.year, v.images
      FROM work_orders w
      LEFT JOIN users u ON w.assignee_id = u.id
      LEFT JOIN users v_user ON w.vendor_id = v_user.id
      LEFT JOIN users c_user ON w.customer_id = c_user.id
      LEFT JOIN vehicles v ON w.vehicle_id = v.id
      WHERE w.id = $1
    `;
    const result = await pool.query(sql, [req.params.id]);
    if (result.rows.length === 0) return errorResponse(res, 'Work order not found', 404);
    
    // Parse images if any
    const wo = result.rows[0];
    if (wo.images && typeof wo.images === 'string') {
        try {
            wo.images = JSON.parse(wo.images);
        } catch(e) {}
    }
    
    successResponse(res, wo, 'Work order retrieved successfully');
  } catch (err) {
    console.error('Error fetching work order:', err);
    errorResponse(res, 'Failed to fetch work order', 500);
  }
});

// Create a work order
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { title, description, location, status, priority, assignee_id, vendor_id, customer_id, due_date, template_id, vehicle_id } = req.body;
    if (!title) return errorResponse(res, 'Title is required', 400);

    const sql = `
      INSERT INTO work_orders 
        (title, description, location, status, priority, assignee_id, vendor_id, customer_id, due_date, template_id, vehicle_id)
      VALUES 
        ($1, $2, $3, COALESCE($4, 'Open'), COALESCE($5, 'Medium'), $6, $7, $8, $9, $10, $11)
      RETURNING *
    `;
    const params = [
      title, 
      description, 
      location, 
      status || 'Open', 
      priority || 'Medium', 
      assignee_id || null, 
      vendor_id || null,
      customer_id || null,
      due_date || null, 
      template_id || null,
      vehicle_id || null
    ];
    
    const result = await pool.query(sql, params);
    successResponse(res, result.rows[0], 'Work order created successfully', 201);
  } catch (err) {
    console.error('Error creating work order:', err);
    errorResponse(res, 'Failed to create work order', 500);
  }
});

// Update a work order
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    // Only update fields that are provided
    const fields = ['title', 'description', 'location', 'status', 'priority', 'assignee_id', 'vendor_id', 'customer_id', 'due_date', 'vehicle_id'];
    const updates = [];
    const params = [];
    let paramIdx = 1;

    for (let field of fields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = $${paramIdx}`);
        params.push(req.body[field]);
        paramIdx++;
      }
    }

    if (updates.length === 0) return errorResponse(res, 'No fields to update', 400);

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    updates.push(`template_id = template_id`); // No-op to avoid syntax errors if nothing else is updated properly, though we already checked length

    params.push(req.params.id);
    const sql = `
      UPDATE work_orders 
      SET ${updates.join(', ')}
      WHERE id = $${paramIdx}
      RETURNING *
    `;

    const result = await pool.query(sql, params);
    if (result.rows.length === 0) return errorResponse(res, 'Work order not found', 404);
    
    successResponse(res, result.rows[0], 'Work order updated successfully');
  } catch (err) {
    console.error('Error updating work order:', err);
    errorResponse(res, 'Failed to update work order', 500);
  }
});

// Delete a work order
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const sql = `DELETE FROM work_orders WHERE id = $1 RETURNING id`;
    const result = await pool.query(sql, [req.params.id]);
    if (result.rows.length === 0) return errorResponse(res, 'Work order not found', 404);
    successResponse(res, null, 'Work order deleted successfully');
  } catch (err) {
    console.error('Error deleting work order:', err);
    errorResponse(res, 'Failed to delete work order', 500);
  }
});

module.exports = router;
