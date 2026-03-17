const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/helpers');

const hashApiKey = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const timingSafeEqualHex = (a, b) => {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

const defaultAlertSettings = {
  alerts_enabled: true,
  overspeed_enabled: true,
  geofence_enabled: false,
  tamper_enabled: true,
  speed_limit_kmh: null,
  geofence_lat: null,
  geofence_lng: null,
  geofence_radius_m: null,
  alert_cooldown_minutes: 10
};

const getActiveBookingForVehicle = async (vehicleId) => {
  const { rows } = await pool.query(
    `SELECT id FROM bookings
     WHERE vehicle_id = $1
       AND status IN ('confirmed', 'active')
       AND start_date <= CURRENT_DATE
       AND end_date >= CURRENT_DATE
     ORDER BY start_date DESC
     LIMIT 1`,
    [vehicleId]
  );
  return rows[0]?.id || null;
};

const getAlertSettings = async (vehicleId) => {
  const { rows } = await pool.query(
    `SELECT * FROM vehicle_alert_settings WHERE vehicle_id = $1`,
    [vehicleId]
  );
  if (!rows[0]) return { ...defaultAlertSettings, vehicle_id: vehicleId };
  return { ...defaultAlertSettings, ...rows[0] };
};

const haversineMeters = (lat1, lon1, lat2, lon2) => {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const shouldThrottleAlert = async (vehicleId, bookingId, type, cooldownMinutes) => {
  const { rows } = await pool.query(
    `SELECT id FROM vehicle_alert_events
     WHERE vehicle_id = $1
       AND type = $2
       AND (
         ($3::int IS NULL AND booking_id IS NULL) OR booking_id = $3
       )
       AND created_at >= NOW() - INTERVAL '${cooldownMinutes} minutes'
     LIMIT 1`,
    [vehicleId, type, bookingId || null]
  );
  return !!rows[0];
};

const createAlertEvent = async ({ vehicleId, bookingId, type, message, latitude, longitude, speed }) => {
  const { rows } = await pool.query(
    `INSERT INTO vehicle_alert_events (vehicle_id, booking_id, type, message, latitude, longitude, speed)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [vehicleId, bookingId || null, type, message, latitude || null, longitude || null, speed || null]
  );

  // Notify owner and (if active booking) customer
  const { rows: vehicleRows } = await pool.query('SELECT owner_id FROM vehicles WHERE id = $1', [vehicleId]);
  const ownerId = vehicleRows[0]?.owner_id;
  let customerId = null;
  if (bookingId) {
    const { rows: bookingRows } = await pool.query('SELECT customer_id FROM bookings WHERE id = $1', [bookingId]);
    customerId = bookingRows[0]?.customer_id || null;
  }

  const title = `Tracking Alert: ${type.replace(/_/g, ' ').toUpperCase()}`;
  const notificationType = 'system';

  const notifyUser = async (userId) => {
    if (!userId) return;
    await pool.query(
      'INSERT INTO notifications (user_id, type, title, message) VALUES ($1, $2, $3, $4)',
      [userId, notificationType, title, message]
    );
  };

  await Promise.all([
    notifyUser(ownerId),
    customerId ? notifyUser(customerId) : Promise.resolve()
  ]);

  return rows[0];
};

const evaluateAlerts = async ({ vehicleId, bookingId, latitude, longitude, speed, status }) => {
  const settings = await getAlertSettings(vehicleId);
  if (!settings.alerts_enabled) return;

  const cooldown = settings.alert_cooldown_minutes || 10;
  const triggered = [];

  if (settings.overspeed_enabled && settings.speed_limit_kmh && speed !== null && speed !== undefined) {
    if (Number(speed) > Number(settings.speed_limit_kmh)) {
      triggered.push({
        type: 'overspeed',
        message: `Speed ${Number(speed).toFixed(1)} km/h exceeded limit ${Number(settings.speed_limit_kmh).toFixed(1)} km/h.`
      });
    }
  }

  if (settings.geofence_enabled && settings.geofence_lat !== null && settings.geofence_lng !== null && settings.geofence_radius_m) {
    const dist = haversineMeters(
      Number(latitude),
      Number(longitude),
      Number(settings.geofence_lat),
      Number(settings.geofence_lng)
    );
    if (dist > Number(settings.geofence_radius_m)) {
      triggered.push({
        type: 'geofence_exit',
        message: `Vehicle exited geofence (${Math.round(dist)} m from center, limit ${Math.round(Number(settings.geofence_radius_m))} m).`
      });
    }
  }

  if (settings.tamper_enabled && status) {
    const statusLower = String(status).toLowerCase();
    if (statusLower.includes('tamper') || statusLower.includes('disconnect') || statusLower.includes('offline')) {
      triggered.push({
        type: 'tamper',
        message: `Device status reported: ${status}`
      });
    }
  }

  for (const alert of triggered) {
    const throttled = await shouldThrottleAlert(vehicleId, bookingId || null, alert.type, cooldown);
    if (throttled) continue;
    await createAlertEvent({
      vehicleId,
      bookingId,
      type: alert.type,
      message: alert.message,
      latitude,
      longitude,
      speed
    });
  }
};

// List devices for a vehicle (owner/admin)
router.get('/vehicle/:vehicleId/devices', authenticateToken, async (req, res) => {
  const vehicleId = parseInt(req.params.vehicleId, 10);
  const userId = req.user.id;
  const role = req.user.role;

  if (!vehicleId) return errorResponse(res, 'Invalid vehicle id', 400);

  try {
    if (role !== 'admin') {
      const { rows: vehicleRows } = await pool.query('SELECT owner_id FROM vehicles WHERE id = $1', [vehicleId]);
      if (!vehicleRows[0]) return errorResponse(res, 'Vehicle not found', 404);
      if (vehicleRows[0].owner_id !== userId) return errorResponse(res, 'Access denied', 403);
    }

    const { rows } = await pool.query(
      `SELECT id, vehicle_id, label, is_active, last_seen, created_at
       FROM vehicle_devices
       WHERE vehicle_id = $1
       ORDER BY created_at DESC`,
      [vehicleId]
    );
    successResponse(res, rows, 'Devices retrieved');
  } catch (err) {
    console.error('Device list error:', err);
    errorResponse(res, 'Failed to fetch devices', 500);
  }
});

// Get alert settings (owner/admin)
router.get('/vehicle/:vehicleId/alert-settings', authenticateToken, async (req, res) => {
  const vehicleId = parseInt(req.params.vehicleId, 10);
  const userId = req.user.id;
  const role = req.user.role;

  if (!vehicleId) return errorResponse(res, 'Invalid vehicle id', 400);

  try {
    if (role !== 'admin') {
      const { rows: vehicleRows } = await pool.query('SELECT owner_id FROM vehicles WHERE id = $1', [vehicleId]);
      if (!vehicleRows[0]) return errorResponse(res, 'Vehicle not found', 404);
      if (vehicleRows[0].owner_id !== userId) return errorResponse(res, 'Access denied', 403);
    }
    const settings = await getAlertSettings(vehicleId);
    successResponse(res, settings, 'Alert settings retrieved');
  } catch (err) {
    console.error('Alert settings fetch error:', err);
    errorResponse(res, 'Failed to fetch alert settings', 500);
  }
});

// Update alert settings (owner/admin)
router.put('/vehicle/:vehicleId/alert-settings', authenticateToken, async (req, res) => {
  const vehicleId = parseInt(req.params.vehicleId, 10);
  const userId = req.user.id;
  const role = req.user.role;

  if (!vehicleId) return errorResponse(res, 'Invalid vehicle id', 400);

  try {
    if (role !== 'admin') {
      const { rows: vehicleRows } = await pool.query('SELECT owner_id FROM vehicles WHERE id = $1', [vehicleId]);
      if (!vehicleRows[0]) return errorResponse(res, 'Vehicle not found', 404);
      if (vehicleRows[0].owner_id !== userId) return errorResponse(res, 'Access denied', 403);
    }

    const {
      alerts_enabled,
      overspeed_enabled,
      geofence_enabled,
      tamper_enabled,
      speed_limit_kmh,
      geofence_lat,
      geofence_lng,
      geofence_radius_m,
      alert_cooldown_minutes
    } = req.body || {};

    const existing = await pool.query('SELECT id FROM vehicle_alert_settings WHERE vehicle_id = $1', [vehicleId]);
    if (!existing.rows[0]) {
      await pool.query(
        `INSERT INTO vehicle_alert_settings (
          vehicle_id, alerts_enabled, overspeed_enabled, geofence_enabled, tamper_enabled,
          speed_limit_kmh, geofence_lat, geofence_lng, geofence_radius_m, alert_cooldown_minutes, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CURRENT_TIMESTAMP)`,
        [
          vehicleId,
          alerts_enabled ?? defaultAlertSettings.alerts_enabled,
          overspeed_enabled ?? defaultAlertSettings.overspeed_enabled,
          geofence_enabled ?? defaultAlertSettings.geofence_enabled,
          tamper_enabled ?? defaultAlertSettings.tamper_enabled,
          speed_limit_kmh ?? null,
          geofence_lat ?? null,
          geofence_lng ?? null,
          geofence_radius_m ?? null,
          alert_cooldown_minutes ?? defaultAlertSettings.alert_cooldown_minutes
        ]
      );
    } else {
      await pool.query(
        `UPDATE vehicle_alert_settings
         SET alerts_enabled = COALESCE($2, alerts_enabled),
             overspeed_enabled = COALESCE($3, overspeed_enabled),
             geofence_enabled = COALESCE($4, geofence_enabled),
             tamper_enabled = COALESCE($5, tamper_enabled),
             speed_limit_kmh = COALESCE($6, speed_limit_kmh),
             geofence_lat = COALESCE($7, geofence_lat),
             geofence_lng = COALESCE($8, geofence_lng),
             geofence_radius_m = COALESCE($9, geofence_radius_m),
             alert_cooldown_minutes = COALESCE($10, alert_cooldown_minutes),
             updated_at = CURRENT_TIMESTAMP
         WHERE vehicle_id = $1`,
        [
          vehicleId,
          alerts_enabled ?? null,
          overspeed_enabled ?? null,
          geofence_enabled ?? null,
          tamper_enabled ?? null,
          speed_limit_kmh ?? null,
          geofence_lat ?? null,
          geofence_lng ?? null,
          geofence_radius_m ?? null,
          alert_cooldown_minutes ?? null
        ]
      );
    }

    const settings = await getAlertSettings(vehicleId);
    successResponse(res, settings, 'Alert settings updated');
  } catch (err) {
    console.error('Alert settings update error:', err);
    errorResponse(res, 'Failed to update alert settings', 500);
  }
});

// Register a device key for a vehicle (owner/admin)
router.post('/device/register', authenticateToken, async (req, res) => {
  const { vehicle_id, label } = req.body;
  const userId = req.user.id;
  const role = req.user.role;

  if (!vehicle_id) {
    return errorResponse(res, 'vehicle_id is required', 400);
  }

  try {
    if (role !== 'admin') {
      const { rows: vehicleRows } = await pool.query('SELECT owner_id FROM vehicles WHERE id = $1', [vehicle_id]);
      if (!vehicleRows[0]) return errorResponse(res, 'Vehicle not found', 404);
      if (vehicleRows[0].owner_id !== userId) return errorResponse(res, 'Access denied', 403);
    }

    const rawKey = `trk_${vehicle_id}_${crypto.randomBytes(24).toString('hex')}`;
    const apiKeyHash = hashApiKey(rawKey);

    const { rows } = await pool.query(
      `INSERT INTO vehicle_devices (vehicle_id, label, api_key_hash)
       VALUES ($1, $2, $3)
       RETURNING id, vehicle_id, label, is_active, created_at`,
      [vehicle_id, label || null, apiKeyHash]
    );

    successResponse(res, { device: rows[0], api_key: rawKey }, 'Device registered. Save the api_key now.');
  } catch (err) {
    console.error('Device register error:', err);
    errorResponse(res, 'Failed to register device', 500);
  }
});

// Revoke a device key (owner/admin)
router.post('/device/revoke', authenticateToken, async (req, res) => {
  const { device_id } = req.body;
  const userId = req.user.id;
  const role = req.user.role;

  if (!device_id) return errorResponse(res, 'device_id is required', 400);

  try {
    if (role !== 'admin') {
      const { rows: deviceRows } = await pool.query(
        `SELECT d.id, v.owner_id FROM vehicle_devices d
         JOIN vehicles v ON d.vehicle_id = v.id
         WHERE d.id = $1`,
        [device_id]
      );
      if (!deviceRows[0]) return errorResponse(res, 'Device not found', 404);
      if (deviceRows[0].owner_id !== userId) return errorResponse(res, 'Access denied', 403);
    }

    await pool.query('UPDATE vehicle_devices SET is_active = FALSE WHERE id = $1', [device_id]);
    successResponse(res, null, 'Device revoked');
  } catch (err) {
    console.error('Device revoke error:', err);
    errorResponse(res, 'Failed to revoke device', 500);
  }
});

// Device live tracking update (API key auth)
router.post('/device/update', async (req, res) => {
  const rawKey = req.header('x-device-key') || req.header('x-tracking-key') || req.body.device_key;
  const { latitude, longitude, speed, fuel_level, mileage, status, booking_id } = req.body;

  if (!rawKey) return errorResponse(res, 'Device key is required', 401);
  if (latitude === undefined || longitude === undefined) {
    return errorResponse(res, 'latitude and longitude are required', 400);
  }

  try {
    const apiKeyHash = hashApiKey(rawKey);
    const { rows: deviceRows } = await pool.query(
      `SELECT id, vehicle_id, api_key_hash, is_active FROM vehicle_devices WHERE api_key_hash = $1`,
      [apiKeyHash]
    );
    const device = deviceRows[0];
    if (!device || !device.is_active || !timingSafeEqualHex(device.api_key_hash, apiKeyHash)) {
      return errorResponse(res, 'Invalid device key', 401);
    }

    const vehicleId = device.vehicle_id;
    const activeBookingId = await getActiveBookingForVehicle(vehicleId);

    let finalBookingId = null;
    if (booking_id) {
      // Only allow booking_id if it matches vehicle and is active
      const { rows: bookingRows } = await pool.query(
        `SELECT id FROM bookings
         WHERE id = $1 AND vehicle_id = $2
           AND status IN ('confirmed', 'active')
           AND start_date <= CURRENT_DATE
           AND end_date >= CURRENT_DATE`,
        [booking_id, vehicleId]
      );
      if (!bookingRows[0]) {
        return errorResponse(res, 'Invalid or inactive booking_id', 400);
      }
      finalBookingId = booking_id;
    } else {
      finalBookingId = activeBookingId;
    }

    const result = await pool.query(
      `INSERT INTO vehicle_tracking (
        vehicle_id, booking_id, latitude, longitude, speed, fuel_level, mileage, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`,
      [vehicleId, finalBookingId, latitude, longitude, speed || null, fuel_level || null, mileage || null, status || null]
    );

    await pool.query(
      `UPDATE vehicles SET location_lat = $1, location_lng = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [latitude, longitude, vehicleId]
    );
    await pool.query(
      `UPDATE vehicle_devices SET last_seen = CURRENT_TIMESTAMP WHERE id = $1`,
      [device.id]
    );

    await evaluateAlerts({
      vehicleId,
      bookingId: finalBookingId,
      latitude,
      longitude,
      speed,
      status
    });

    successResponse(res, result.rows[0], 'Tracking updated');
  } catch (err) {
    console.error('Device tracking update error:', err);
    errorResponse(res, 'Failed to update tracking', 500);
  }
});

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

    let finalBookingId = booking_id || null;
    if (booking_id) {
      const { rows: bookingRows } = await pool.query(
        `SELECT id FROM bookings
         WHERE id = $1 AND vehicle_id = $2`,
        [booking_id, vehicle_id]
      );
      if (!bookingRows[0]) {
        return errorResponse(res, 'Invalid booking_id for vehicle', 400);
      }
    } else {
      finalBookingId = await getActiveBookingForVehicle(vehicle_id);
    }

    const result = await pool.query(
      `INSERT INTO vehicle_tracking (
        vehicle_id, booking_id, latitude, longitude, speed, fuel_level, mileage, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`,
      [vehicle_id, finalBookingId, latitude, longitude, speed || null, fuel_level || null, mileage || null, status || null]
    );
    await pool.query(
      `UPDATE vehicles SET location_lat = $1, location_lng = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [latitude, longitude, vehicle_id]
    );

    await evaluateAlerts({
      vehicleId: vehicle_id,
      bookingId: finalBookingId,
      latitude,
      longitude,
      speed,
      status
    });

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

    const today = new Date().toISOString().slice(0, 10);
    if (!(booking.status === 'confirmed' || booking.status === 'active') ||
      booking.start_date > today || booking.end_date < today) {
      return errorResponse(res, 'Tracking available only during active booking period', 403);
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

// Get tracking history by booking (owner/admin/customer during active booking)
router.get('/booking/:bookingId/history', authenticateToken, async (req, res) => {
  const bookingId = parseInt(req.params.bookingId, 10);
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
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

    const today = new Date().toISOString().slice(0, 10);
    if (!(booking.status === 'confirmed' || booking.status === 'active') ||
      booking.start_date > today || booking.end_date < today) {
      return errorResponse(res, 'Tracking available only during active booking period', 403);
    }

    const { rows } = await pool.query(
      `SELECT * FROM vehicle_tracking
       WHERE booking_id = $1
       ORDER BY timestamp DESC
       LIMIT $2`,
      [bookingId, limit]
    );

    successResponse(res, rows, 'Tracking history fetched');
  } catch (err) {
    console.error('Tracking history error:', err);
    errorResponse(res, 'Failed to fetch tracking history', 500);
  }
});

// Get tracking history by vehicle (owner/admin)
router.get('/vehicle/:vehicleId/history', authenticateToken, async (req, res) => {
  const vehicleId = parseInt(req.params.vehicleId, 10);
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const userId = req.user.id;
  const role = req.user.role;

  if (!vehicleId) return errorResponse(res, 'Invalid vehicle id', 400);

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
       LIMIT $2`,
      [vehicleId, limit]
    );

    successResponse(res, rows, 'Tracking history fetched');
  } catch (err) {
    console.error('Tracking history error:', err);
    errorResponse(res, 'Failed to fetch tracking history', 500);
  }
});

// Get alerts by booking (owner/customer/admin)
router.get('/booking/:bookingId/alerts', authenticateToken, async (req, res) => {
  const bookingId = parseInt(req.params.bookingId, 10);
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const userId = req.user.id;
  const role = req.user.role;

  if (!bookingId) return errorResponse(res, 'Invalid booking id', 400);

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

    const { rows } = await pool.query(
      `SELECT * FROM vehicle_alert_events
       WHERE booking_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [bookingId, limit]
    );
    successResponse(res, rows, 'Alert history fetched');
  } catch (err) {
    console.error('Alert history error:', err);
    errorResponse(res, 'Failed to fetch alert history', 500);
  }
});

// Get alerts by vehicle (owner/admin)
router.get('/vehicle/:vehicleId/alerts', authenticateToken, async (req, res) => {
  const vehicleId = parseInt(req.params.vehicleId, 10);
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const userId = req.user.id;
  const role = req.user.role;

  if (!vehicleId) return errorResponse(res, 'Invalid vehicle id', 400);

  try {
    if (role !== 'admin') {
      const { rows: vehicleRows } = await pool.query('SELECT owner_id FROM vehicles WHERE id = $1', [vehicleId]);
      if (!vehicleRows[0]) return errorResponse(res, 'Vehicle not found', 404);
      if (vehicleRows[0].owner_id !== userId) return errorResponse(res, 'Access denied', 403);
    }

    const { rows } = await pool.query(
      `SELECT * FROM vehicle_alert_events
       WHERE vehicle_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [vehicleId, limit]
    );
    successResponse(res, rows, 'Alert history fetched');
  } catch (err) {
    console.error('Alert history error:', err);
    errorResponse(res, 'Failed to fetch alert history', 500);
  }
});

module.exports = router;
