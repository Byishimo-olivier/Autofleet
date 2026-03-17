const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/helpers');

// Update live tracking (owner/admin/device)
router.post('/update', authenticateToken, async (req, res) => {
  const { vehicle_id, booking_id, latitude, longitude, speed, fuel_level, mileage, status } = req.body;
  const userId = req.user.id;
  const role = req.user.role;

  if (!vehicle_id || latitude === undefined || longitude === undefined) {
    return errorResponse(res, 'vehicle_id, latitude, and longitude are required', 400);
  }

  try {
    // Only owner of the vehicle or admin can push live updates
    if (role !== 'admin') {
      const { rows: vehicleRows } = await pool.query('SELECT owner_id FROM vehicles WHERE id = $1', [vehicle_id]);
      if (!vehicleRows[0]) {
        return errorResponse(res, 'Vehicle not found', 404);
      }
      if (vehicleRows[0].owner_id !== userId) {
        return errorResponse(res, 'Access denied', 403);
      }
    }

    const result = await pool.query(
      `INSERT INTO vehicle_tracking (
        vehicle_id, booking_id, latitude, longitude, speed, fuel_level, mileage, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`,
      [vehicle_id, booking_id || null, latitude, longitude, speed || null, fuel_level || null, mileage || null, status || null]
    );

    successResponse(res, result.rows[0], 'Tracking updated');
  } catch (err) {
    console.error('Tracking update error:', err);
    errorResponse(res, 'Failed to update tracking', 500);
  }
});

// Get latest tracking by booking (owner or customer who booked)
router.get('/booking/:bookingId/latest', authenticateToken, async (req, res) => {
  const bookingId = parseInt(req.params.bookingId, 10);
  const userId = req.user.id;
  const role = req.user.role;

  if (!bookingId) {
    return errorResponse(res, 'Invalid booking id', 400);
  }

  try {
    const { rows: bookingRows } = await pool.query(
      `SELECT b.*, v.owner_id FROM bookings b
       LEFT JOIN vehicles v ON b.vehicle_id = v.id
       WHERE b.id = $1`,
      [bookingId]
    );

    const booking = bookingRows[0];
    if (!booking) return errorResponse(res, 'Booking not found', 404);

    const isOwner = booking.owner_id === userId;
    const isCustomer = booking.customer_id === userId;

    if (!(role === 'admin' || isOwner || isCustomer)) {
      return errorResponse(res, 'Access denied', 403);
    }

    const { rows: trackRows } = await pool.query(
      `SELECT * FROM vehicle_tracking
       WHERE booking_id = $1
       ORDER BY timestamp DESC
       LIMIT 1`,
      [bookingId]
    );

    if (!trackRows[0]) {
      return successResponse(res, null, 'No tracking data yet');
    }

    successResponse(res, trackRows[0], 'Latest tracking fetched');
  } catch (err) {
    console.error('Tracking fetch error:', err);
    errorResponse(res, 'Failed to fetch tracking', 500);
  }
});

// Get latest tracking by vehicle (owner/admin)
router.get('/vehicle/:vehicleId/latest', authenticateToken, async (req, res) => {
  const vehicleId = parseInt(req.params.vehicleId, 10);
  const userId = req.user.id;
  const role = req.user.role;

  if (!vehicleId) {
    return errorResponse(res, 'Invalid vehicle id', 400);
  }

  try {
    if (role !== 'admin') {
      const { rows: vehicleRows } = await pool.query('SELECT owner_id FROM vehicles WHERE id = $1', [vehicleId]);
      if (!vehicleRows[0]) return errorResponse(res, 'Vehicle not found', 404);
      if (vehicleRows[0].owner_id !== userId) return errorResponse(res, 'Access denied', 403);
    }

    const { rows } = await pool.query(
      `SELECT * FROM vehicle_tracking
       WHERE vehicle_id = $1
       ORDER BY timestamp DESC
       LIMIT 1`,
      [vehicleId]
    );

    successResponse(res, rows[0] || null, 'Latest tracking fetched');
  } catch (err) {
    console.error('Tracking fetch error:', err);
    errorResponse(res, 'Failed to fetch tracking', 500);
  }
});

module.exports = router;
