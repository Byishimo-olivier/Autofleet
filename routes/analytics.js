const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken, requireOwnerOrAdmin, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/helpers');

function getDurationDays(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const diffTime = Math.abs(end - start);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1; // +1 to include both start and end date
  return diffDays;
}

// Analytics dashboard data for frontend (alternative endpoint)
router.get('/dashboard/data', authenticateToken, requireOwnerOrAdmin, async (req, res) => {
  const requestingUserId = req.user.id;
  const requestingUserRole = req.user.role;
  const { period = '30', limit = 6 } = req.query;
  const periodInt = parseInt(period, 10) || 30;
  const limitInt = parseInt(limit, 10) || 6;
  const isOwner = requestingUserRole === 'owner';
  const ownerParam = isOwner ? [requestingUserId] : [];
  const statsParams = ownerParam;
  const statsCondition = isOwner ? 'AND v.owner_id = $1' : '';
  try {
    // Stats
    const totalVehiclesQ = await pool.query(`SELECT COUNT(*) as total FROM vehicles v WHERE 1=1 ${statsCondition}`, statsParams);
    // Active bookings for today: any booking where today is between start_date and end_date and a vehicle is booked
    const activeBookingsQ = await pool.query(
      `SELECT COUNT(*) as active
       FROM bookings b
       LEFT JOIN vehicles v ON b.vehicle_id = v.id
       WHERE b.start_date <= CURRENT_DATE
         AND b.end_date >= CURRENT_DATE
         AND b.vehicle_id IS NOT NULL
         ${statsCondition}`,
      statsParams
    );
    // myRevenue: owner gets their vehicles' bookings only; admin gets all (same as platform)
    let myRevenueQ;
    if (requestingUserRole === 'owner') {
      myRevenueQ = await pool.query(
        `SELECT COALESCE(SUM(b.total_amount), 0) as revenue
         FROM bookings b
         LEFT JOIN vehicles v ON b.vehicle_id = v.id
         WHERE v.owner_id = $1`,
        [requestingUserId]
      );
    } else {
      // For admin: myRevenue = platform total (no restriction)
      myRevenueQ = await pool.query(
        `SELECT COALESCE(SUM(total_amount), 0) as revenue FROM bookings`
      );
    }

    // platformRevenue: ALL bookings total (always, regardless of role)
    const platformRevenueQ = await pool.query(
      `SELECT COALESCE(SUM(total_amount), 0) as revenue FROM bookings`
    );

    const avgRatingQ = await pool.query(`SELECT AVG(f.rating) as avg_rating FROM feedback f LEFT JOIN vehicles v ON f.vehicle_id = v.id WHERE f.created_at >= NOW() - INTERVAL '${periodInt} days' ${statsCondition}`, statsParams);

    // Booking trends: most recent 30 days that have any bookings (all-time, so chart is never empty)
    const bookingTrendsQ = await pool.query(`
      SELECT TO_CHAR(DATE(b.created_at), 'Mon DD') as date,
             COUNT(*) as bookings
      FROM bookings b
      LEFT JOIN vehicles v ON b.vehicle_id = v.id
      WHERE 1=1 ${statsCondition}
      GROUP BY DATE(b.created_at), TO_CHAR(DATE(b.created_at), 'Mon DD')
      ORDER BY DATE(b.created_at) DESC
      LIMIT 30
    `, statsParams);
    // Reverse so oldest is on the left of the chart
    const bookingTrends = bookingTrendsQ.rows
      .reverse()
      .map(row => ({ date: row.date, bookings: parseInt(row.bookings) }));

    // Total bookings (all time)
    const totalBookingsQ = await pool.query(
      `SELECT COUNT(*) as total FROM bookings b LEFT JOIN vehicles v ON b.vehicle_id = v.id WHERE 1=1 ${statsCondition}`,
      statsParams
    );
    const totalBookings = totalBookingsQ.rows[0]?.total ? parseInt(totalBookingsQ.rows[0].total) : 0;

    // Fleet status
    const fleetStatusQ = await pool.query(`
      SELECT status, COUNT(*) as count
      FROM vehicles v
      WHERE 1=1 ${statsCondition}
      GROUP BY status
    `, statsParams);
    const fleetStatus = fleetStatusQ.rows.map(row => ({ label: row.status, value: parseInt(row.count) }));

    // Recent bookings
    const recentBookingsQ = await pool.query(`
      SELECT b.id, u.first_name || ' ' || u.last_name as name, v.make || ' ' || v.model as car, b.status, b.start_date, b.end_date
      FROM bookings b
      LEFT JOIN users u ON b.customer_id = u.id
      LEFT JOIN vehicles v ON b.vehicle_id = v.id
      WHERE 1=1 ${statsCondition}
      ORDER BY b.created_at DESC
      LIMIT 5
    `, statsParams);
    const recentBookings = recentBookingsQ.rows.map(row => ({
      name: row.name,
      car: `${row.car} - ${getDurationDays(row.start_date, row.end_date)} days`,
      status: row.status
    }));

    // Define stat values before using them in the response
    const totalVehicles = totalVehiclesQ.rows[0]?.total ? parseInt(totalVehiclesQ.rows[0].total) : 0;
    const activeBookings = activeBookingsQ.rows[0]?.active ? parseInt(activeBookingsQ.rows[0].active) : 0;

    const myRevenue = parseFloat(myRevenueQ.rows[0]?.revenue ?? 0) || 0;
    const platformRevenue = parseFloat(platformRevenueQ.rows[0]?.revenue ?? 0) || 0;

    let avgRating = 0;
    if (avgRatingQ.rows[0] && avgRatingQ.rows[0].avg_rating !== null && avgRatingQ.rows[0].avg_rating !== undefined && !isNaN(avgRatingQ.rows[0].avg_rating)) {
      avgRating = parseFloat(avgRatingQ.rows[0].avg_rating).toFixed(1);
    }
    if (!isFinite(avgRating)) avgRating = 0;

    // Compose fleetStatus object
    const fleetStatusObj = { available: 0, rented: 0, maintenance: 0 };
    if (Array.isArray(fleetStatus)) {
      fleetStatus.forEach(item => {
        if (item.label && typeof item.value === 'number') {
          const key = item.label.toLowerCase();
          if (key === 'available' || key === 'rented' || key === 'maintenance') {
            fleetStatusObj[key] = item.value;
          }
        }
      });
    }

    // Compose recentBookings array with expected keys
    const safeRecentBookings = Array.isArray(recentBookings)
      ? recentBookings.map(row => ({
        customer: typeof row.name === 'string' && row.name.trim() ? row.name : 'N/A',
        vehicle: typeof row.car === 'string' && row.car.trim() ? row.car.split(' - ')[0] : 'N/A',
        duration: typeof row.car === 'string' && row.car.includes(' - ') ? row.car.split(' - ')[1] : 'N/A',
        status: typeof row.status === 'string' && row.status.trim() ? row.status : 'N/A',
      }))
      : [];

    // Compose response with exact keys expected by frontend
    successResponse(res, {
      totalVehicles,
      activeBookings,
      totalBookings,
      myRevenue,
      platformRevenue,
      avgRating: Number.isFinite(Number(avgRating)) ? Number(avgRating) : 0,
      fleetStatus: fleetStatusObj,
      bookingTrends: Array.isArray(bookingTrends) ? bookingTrends : [],
      recentBookings: safeRecentBookings
    }, 'Dashboard analytics data');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Failed to retrieve analytics dashboard data', 500);
  }
});

// Analytics dashboard summary for frontend
router.get('/dashboard/summary', authenticateToken, requireOwnerOrAdmin, async (req, res) => {
  const requestingUserId = req.user.id;
  const requestingUserRole = req.user.role;
  const { period = '30', limit = 6 } = req.query;
  const periodInt = parseInt(period, 10) || 30;
  const limitInt = parseInt(limit, 10) || 6;

  const isOwner = requestingUserRole === 'owner';
  const ownerParam = isOwner ? [requestingUserId] : [];

  const statsParams = ownerParam;
  const statsCondition = isOwner ? 'AND v.owner_id = $1' : '';

  const rbParams = isOwner ? [requestingUserId, limitInt] : [limitInt];
  const rbCondition = isOwner ? 'AND v.owner_id = $1' : '';

  let totalBookingsVal = 1;

  try {
    // Stats - use MAKE_INTERVAL instead of string interpolation
    const totalRevenueQ = await pool.query(
      `SELECT SUM(total_amount) as revenue 
       FROM bookings b 
       LEFT JOIN vehicles v ON b.vehicle_id = v.id 
       WHERE b.payment_status = 'paid' AND b.created_at >= NOW() - MAKE_INTERVAL(days => $${statsParams.length + 1}) 
       ${statsCondition}`,
      [...statsParams, periodInt]
    );

    const totalBookingsQ = await pool.query(
      `SELECT COUNT(*) as total 
       FROM bookings b 
       LEFT JOIN vehicles v ON b.vehicle_id = v.id 
       WHERE b.created_at >= NOW() - MAKE_INTERVAL(days => $${statsParams.length + 1}) 
       ${statsCondition}`,
      [...statsParams, periodInt]
    );

    totalBookingsVal = parseInt(totalBookingsQ.rows[0].total || 1, 10);

    const fleetUtilizationQ = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'rented')::float / NULLIF(COUNT(*),0) * 100 as utilization 
       FROM vehicles v 
       WHERE 1=1 ${statsCondition}`,
      statsParams
    );

    const avgRatingQ = await pool.query(
      `SELECT AVG(f.rating) as avg_rating 
       FROM feedback f 
       LEFT JOIN vehicles v ON f.vehicle_id = v.id 
       WHERE f.created_at >= NOW() - MAKE_INTERVAL(days => $${statsParams.length + 1}) 
       ${statsCondition}`,
      [...statsParams, periodInt]
    );

    // Revenue by vehicles
    const revenueDataQ = await pool.query(
      `SELECT v.make || ' ' || v.model as name, 
              SUM(CASE WHEN b.payment_status = 'paid' THEN b.total_amount ELSE 0 END) as revenue
       FROM vehicles v
       LEFT JOIN bookings b ON v.id = b.vehicle_id 
       AND b.created_at >= NOW() - MAKE_INTERVAL(days => $${rbParams.length + 1})
       WHERE 1=1 ${rbCondition}
       GROUP BY v.id
       ORDER BY revenue DESC
       LIMIT $${rbParams.length}`,
      [...rbParams, periodInt]
    );

    // Bookings per vehicle
    const bookingsDataQ = await pool.query(
      `SELECT v.make || ' ' || v.model as name, 
              COUNT(b.id) as bookings
       FROM vehicles v
       LEFT JOIN bookings b ON v.id = b.vehicle_id 
       AND b.created_at >= NOW() - MAKE_INTERVAL(days => $${rbParams.length + 1})
       WHERE 1=1 ${rbCondition}
       GROUP BY v.id
       ORDER BY bookings DESC
       LIMIT $${rbParams.length}`,
      [...rbParams, periodInt]
    );

    // Vehicle performance table
    const vParams = isOwner
      ? [totalBookingsVal, periodInt, requestingUserId, limitInt]
      : [totalBookingsVal, periodInt, limitInt];
    const vCondition = isOwner ? 'AND v.owner_id = $3' : '';

    const vehiclesQ = await pool.query(
      `SELECT v.make, v.model, v.year, v.type, v.status, v.daily_rate,
              SUM(CASE WHEN b.payment_status = 'paid' THEN b.total_amount ELSE 0 END) as revenue,
              COUNT(b.id) as bookings,
              (COUNT(b.id)::float / NULLIF($1::float,0)) * 100 as utilization,
              AVG(f.rating) as rating
       FROM vehicles v
       LEFT JOIN bookings b ON v.id = b.vehicle_id 
       AND b.created_at >= NOW() - MAKE_INTERVAL(days => $2)
       LEFT JOIN feedback f ON v.id = f.vehicle_id
       WHERE 1=1 ${vCondition}
       GROUP BY v.id
       ORDER BY revenue DESC
       LIMIT $${vParams.length}`,
      vParams
    );

    const stats = [
      {
        label: 'Total Revenue',
        value: `$${parseFloat(totalRevenueQ.rows[0].revenue || 0).toLocaleString()}`,
      },
      {
        label: 'Total Bookings',
        value: parseInt(totalBookingsQ.rows[0].total) || 0,
      },
      {
        label: 'Fleet Utilization',
        value: fleetUtilizationQ.rows[0].utilization ? `${parseFloat(fleetUtilizationQ.rows[0].utilization).toFixed(1)}%` : '0%',
      },
      {
        label: 'Avg Rating',
        value: avgRatingQ.rows[0].avg_rating ? parseFloat(avgRatingQ.rows[0].avg_rating).toFixed(1) : 0,
      },
    ];

    const revenueData = revenueDataQ.rows.map(r => ({ name: r.name, revenue: parseFloat(r.revenue || 0) }));
    const bookingsData = bookingsDataQ.rows.map(r => ({ name: r.name, bookings: parseInt(r.bookings) }));
    const vehicles = vehiclesQ.rows.map(v => ({
      name: `${v.make} ${v.model}`,
      type: `${v.type} - ${v.year}`,
      revenue: `$${parseFloat(v.revenue || 0).toLocaleString()}`,
      bookings: parseInt(v.bookings),
      utilization: v.utilization ? Math.round(parseFloat(v.utilization)) : 0,
      rating: v.rating ? parseFloat(v.rating).toFixed(1) : 0,
      status: v.status,
    }));

    successResponse(res, { stats, revenueData, bookingsData, vehicles }, 'Analytics dashboard summary');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Failed to retrieve analytics dashboard summary', 500);
  }
});

// Helper to build vehicle condition and params
function getVehicleConditionAndParams(role, userId, paramStart = 1) {
  let vehicleCondition = '';
  let params = [];
  if (role === 'owner') {
    vehicleCondition = `AND v.owner_id = $${paramStart}`;
    params.push(userId);
  }
  return { vehicleCondition, params };
}

// Dashboard analytics
router.get('/dashboard', authenticateToken, requireOwnerOrAdmin, async (req, res) => {
  const requestingUserId = req.user.id;
  const requestingUserRole = req.user.role;
  const { period = '30' } = req.query;
  const periodInt = parseInt(period, 10);
  const { vehicleCondition, params } = getVehicleConditionAndParams(requestingUserRole, requestingUserId);

  try {
    const totalVehicles = await pool.query(
      `SELECT COUNT(*) as total FROM vehicles v WHERE 1=1 ${vehicleCondition}`,
      params
    );

    const availableVehicles = await pool.query(
      `SELECT COUNT(*) as available FROM vehicles v WHERE status = 'available' ${vehicleCondition}`,
      params
    );

    const totalBookings = await pool.query(
      `SELECT COUNT(*) as total 
       FROM bookings b 
       LEFT JOIN vehicles v ON b.vehicle_id = v.id 
       WHERE b.created_at >= NOW() - MAKE_INTERVAL(days => $${params.length + 1}) 
       ${vehicleCondition}`,
      [...params, periodInt]
    );

    const totalRevenue = await pool.query(
      `SELECT SUM(total_amount) as revenue 
       FROM bookings b 
       LEFT JOIN vehicles v ON b.vehicle_id = v.id 
       WHERE b.payment_status = 'paid' 
       AND b.created_at >= NOW() - MAKE_INTERVAL(days => $${params.length + 1}) 
       ${vehicleCondition}`,
      [...params, periodInt]
    );

    const activeBookings = await pool.query(
      `SELECT COUNT(*) as active 
       FROM bookings b 
       LEFT JOIN vehicles v ON b.vehicle_id = v.id 
       WHERE b.status = 'active' ${vehicleCondition}`,
      params
    );

    const averageRating = await pool.query(
      `SELECT AVG(f.rating) as avg_rating 
       FROM feedback f 
       LEFT JOIN vehicles v ON f.vehicle_id = v.id 
       WHERE f.created_at >= NOW() - MAKE_INTERVAL(days => $${params.length + 1}) 
       ${vehicleCondition}`,
      [...params, periodInt]
    );

    const analytics = {
      totalVehicles: parseInt(totalVehicles.rows[0].total),
      availableVehicles: parseInt(availableVehicles.rows[0].available),
      totalBookings: parseInt(totalBookings.rows[0].total),
      totalRevenue: parseFloat(totalRevenue.rows[0].revenue || 0),
      activeBookings: parseInt(activeBookings.rows[0].active),
      averageRating: averageRating.rows[0].avg_rating ? parseFloat(Number(averageRating.rows[0].avg_rating).toFixed(2)) : 0
    };

    successResponse(res, analytics, 'Dashboard analytics retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Failed to retrieve analytics', 500);
  }
});

// Booking trends
router.get('/bookings/trends', authenticateToken, requireOwnerOrAdmin, async (req, res) => {
  const requestingUserId = req.user.id;
  const requestingUserRole = req.user.role;
  const { period = '30' } = req.query;
  const periodInt = parseInt(period, 10) || 30;
  const { vehicleCondition, params } = getVehicleConditionAndParams(requestingUserRole, requestingUserId, 2);

  try {
    const sql = `
      SELECT 
        TO_CHAR(DATE(b.created_at), 'Mon DD') as date,
        COUNT(*) as bookings,
        SUM(b.total_amount) as revenue,
        AVG(b.total_amount) as avg_booking_value
      FROM bookings b
      LEFT JOIN vehicles v ON b.vehicle_id = v.id
      WHERE b.created_at >= NOW() - MAKE_INTERVAL(days => $1) ${vehicleCondition}
      GROUP BY DATE(b.created_at), TO_CHAR(DATE(b.created_at), 'Mon DD')
      ORDER BY DATE(b.created_at)
    `;

    const result = await pool.query(sql, [periodInt, ...params]);

    const formattedTrends = result.rows.map(trend => ({
      date: trend.date,
      bookings: parseInt(trend.bookings),
      revenue: parseFloat(trend.revenue || 0),
      avgBookingValue: parseFloat(trend.avg_booking_value || 0)
    }));

    successResponse(res, formattedTrends, 'Booking trends retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Database error', 500);
  }
});

// Vehicle utilization
router.get('/vehicles/utilization', authenticateToken, requireOwnerOrAdmin, async (req, res) => {
  const requestingUserId = req.user.id;
  const requestingUserRole = req.user.role;
  const { period = '30' } = req.query;
  const periodInt = parseInt(period, 10);
  const { vehicleCondition, params } = getVehicleConditionAndParams(requestingUserRole, requestingUserId, 3);

  try {
    const sql = `
      SELECT 
        v.id,
        v.make,
        v.model,
        v.year,
        v.license_plate,
        v.type,
        v.daily_rate,
        COUNT(b.id) as total_bookings,
        SUM(CASE WHEN b.status = 'completed' THEN 1 ELSE 0 END) as completed_bookings,
        SUM(CASE WHEN b.payment_status = 'paid' THEN b.total_amount ELSE 0 END) as total_revenue,
        AVG(f.rating) as avg_rating,
        COUNT(f.id) as total_reviews
      FROM vehicles v
      LEFT JOIN bookings b ON v.id = b.vehicle_id AND b.created_at >= NOW() - MAKE_INTERVAL(days => $1)
      LEFT JOIN feedback f ON v.id = f.vehicle_id AND f.created_at >= NOW() - MAKE_INTERVAL(days => $2)
      WHERE 1=1 ${vehicleCondition}
      GROUP BY v.id
      ORDER BY total_revenue DESC
    `;

    const result = await pool.query(sql, [periodInt, periodInt, ...params]);

    const formattedUtilization = result.rows.map(vehicle => ({
      vehicleId: vehicle.id,
      make: vehicle.make,
      model: vehicle.model,
      year: vehicle.year,
      licensePlate: vehicle.license_plate,
      type: vehicle.type,
      dailyRate: parseFloat(vehicle.daily_rate),
      totalBookings: parseInt(vehicle.total_bookings),
      completedBookings: parseInt(vehicle.completed_bookings),
      totalRevenue: parseFloat(vehicle.total_revenue || 0),
      averageRating: vehicle.avg_rating ? parseFloat(vehicle.avg_rating.toFixed(2)) : 0,
      totalReviews: parseInt(vehicle.total_reviews),
      utilizationRate: vehicle.total_bookings > 0 ?
        parseFloat(((vehicle.completed_bookings / vehicle.total_bookings) * 100).toFixed(2)) : 0
    }));

    successResponse(res, formattedUtilization, 'Vehicle utilization retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Database error', 500);
  }
});

// Revenue analytics
router.get('/revenue', authenticateToken, requireOwnerOrAdmin, async (req, res) => {
  const requestingUserId = req.user.id;
  const requestingUserRole = req.user.role;
  const { period = '30', groupBy = 'day' } = req.query;
  const periodInt = parseInt(period, 10);
  const { vehicleCondition, params } = getVehicleConditionAndParams(requestingUserRole, requestingUserId, 2);

  let dateFormat = '';
  switch (groupBy) {
    case 'week':
      dateFormat = `TO_CHAR(b.created_at, 'IYYY-IW')`;
      break;
    case 'month':
      dateFormat = `TO_CHAR(b.created_at, 'YYYY-MM')`;
      break;
    default:
      dateFormat = `TO_CHAR(b.created_at, 'YYYY-MM-DD')`;
  }

  try {
    const sql = `
      SELECT 
        ${dateFormat} as period,
        COUNT(*) as total_bookings,
        SUM(CASE WHEN b.payment_status = 'paid' THEN b.total_amount ELSE 0 END) as paid_revenue,
        SUM(CASE WHEN b.payment_status = 'pending' THEN b.total_amount ELSE 0 END) as pending_revenue,
        AVG(CASE WHEN b.payment_status = 'paid' THEN b.total_amount ELSE NULL END) as avg_booking_value
      FROM bookings b
      LEFT JOIN vehicles v ON b.vehicle_id = v.id
      WHERE b.created_at >= NOW() - MAKE_INTERVAL(days => $1) ${vehicleCondition}
      GROUP BY period
      ORDER BY period
    `;

    const result = await pool.query(sql, [periodInt, ...params]);

    const formattedRevenue = result.rows.map(item => ({
      period: item.period,
      totalBookings: parseInt(item.total_bookings),
      paidRevenue: parseFloat(item.paid_revenue || 0),
      pendingRevenue: parseFloat(item.pending_revenue || 0),
      avgBookingValue: parseFloat(item.avg_booking_value || 0)
    }));

    successResponse(res, formattedRevenue, 'Revenue analytics retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Database error', 500);
  }
});

// Customer analytics
router.get('/customers', authenticateToken, requireAdmin, async (req, res) => {
  const { period = '30' } = req.query;
  const periodInt = parseInt(period, 10);

  try {
    const newCustomers = await pool.query(
      `SELECT COUNT(*) as new_customers 
       FROM users 
       WHERE role = 'customer' 
       AND created_at >= NOW() - MAKE_INTERVAL(days => $1)`,
      [periodInt]
    );

    const topCustomers = await pool.query(`
      SELECT u.id, u.first_name, u.last_name, u.email,
        COUNT(b.id) as total_bookings,
        SUM(CASE WHEN b.payment_status = 'paid' THEN b.total_amount ELSE 0 END) as total_spent
      FROM users u
      LEFT JOIN bookings b ON u.id = b.customer_id 
      AND b.created_at >= NOW() - MAKE_INTERVAL(days => $1)
      WHERE u.role = 'customer'
      GROUP BY u.id
      HAVING COUNT(b.id) > 0
      ORDER BY total_spent DESC
      LIMIT 10
    `, [periodInt]);

    const repeatCustomers = await pool.query(`
      SELECT COUNT(DISTINCT customer_id) as repeat_customers
      FROM bookings
      WHERE customer_id IN (
        SELECT customer_id 
        FROM bookings 
        WHERE created_at >= NOW() - MAKE_INTERVAL(days => $1) 
        GROUP BY customer_id 
        HAVING COUNT(*) > 1
      )
    `, [periodInt]);

    const analytics = {
      newCustomers: parseInt(newCustomers.rows[0].new_customers),
      topCustomers: topCustomers.rows.map(customer => ({
        customerId: customer.id,
        name: `${customer.first_name} ${customer.last_name}`,
        email: customer.email,
        totalBookings: parseInt(customer.total_bookings),
        totalSpent: parseFloat(customer.total_spent || 0)
      })),
      repeatCustomers: parseInt(repeatCustomers.rows[0].repeat_customers)
    };

    successResponse(res, analytics, 'Customer analytics retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Failed to retrieve customer analytics', 500);
  }
});

// Popular vehicles
router.get('/vehicles/popular', authenticateToken, requireOwnerOrAdmin, async (req, res) => {
  const requestingUserId = req.user.id;
  const requestingUserRole = req.user.role;
  const { period = '30', limit = 10 } = req.query;
  const periodInt = parseInt(period, 10);
  const limitInt = parseInt(limit, 10);

  let { vehicleCondition, params } = getVehicleConditionAndParams(requestingUserRole, requestingUserId, 2);
  params = [periodInt, ...params, limitInt];

  try {
    const sql = `
      SELECT 
        v.id,
        v.make,
        v.model,
        v.year,
        v.type,
        v.daily_rate,
        COUNT(b.id) as booking_count,
        SUM(CASE WHEN b.payment_status = 'paid' THEN b.total_amount ELSE 0 END) as revenue,
        AVG(f.rating) as avg_rating,
        COUNT(f.id) as review_count
      FROM vehicles v
      LEFT JOIN bookings b ON v.id = b.vehicle_id 
      AND b.created_at >= NOW() - MAKE_INTERVAL(days => $1)
      LEFT JOIN feedback f ON v.id = f.vehicle_id
      WHERE 1=1 ${vehicleCondition}
      GROUP BY v.id
      HAVING COUNT(b.id) > 0
      ORDER BY booking_count DESC, revenue DESC
      LIMIT $${params.length}
    `;

    const result = await pool.query(sql, params);

    const formattedVehicles = result.rows.map(vehicle => ({
      vehicleId: vehicle.id,
      make: vehicle.make,
      model: vehicle.model,
      year: vehicle.year,
      type: vehicle.type,
      dailyRate: parseFloat(vehicle.daily_rate),
      bookingCount: parseInt(vehicle.booking_count),
      revenue: parseFloat(vehicle.revenue || 0),
      averageRating: vehicle.avg_rating ? parseFloat(vehicle.avg_rating.toFixed(2)) : 0,
      reviewCount: parseInt(vehicle.review_count)
    }));

    successResponse(res, formattedVehicles, 'Popular vehicles retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Database error', 500);
  }
});

// Booking status distribution
router.get('/bookings/status', authenticateToken, requireOwnerOrAdmin, async (req, res) => {
  const requestingUserId = req.user.id;
  const requestingUserRole = req.user.role;
  const { period = '30' } = req.query;
  const periodInt = parseInt(period, 10);
  const { vehicleCondition, params } = getVehicleConditionAndParams(requestingUserRole, requestingUserId, 2);

  try {
    const sql = `
      SELECT 
        b.status,
        COUNT(*) as count,
        SUM(b.total_amount) as total_amount
      FROM bookings b
      LEFT JOIN vehicles v ON b.vehicle_id = v.id
      WHERE b.created_at >= NOW() - MAKE_INTERVAL(days => $1) ${vehicleCondition}
      GROUP BY b.status
      ORDER BY count DESC
    `;

    const result = await pool.query(sql, [periodInt, ...params]);

    const formattedData = result.rows.map(item => ({
      status: item.status,
      count: parseInt(item.count),
      totalAmount: parseFloat(item.total_amount || 0)
    }));

    successResponse(res, formattedData, 'Booking status distribution retrieved successfully');
  } catch (err) {
    console.error('Database error:', err);
    errorResponse(res, 'Database error', 500);
  }
});

module.exports = router;