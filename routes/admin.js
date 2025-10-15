const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/helpers');

// Get dashboard statistics for cards (FIXED VERSION)
router.get('/stats/dashboard', authenticateToken, requireAdmin, async (req, res) => {
  try {
    console.log('=== ADMIN DASHBOARD STATS DEBUG ===');
    
    // Get current month boundaries
    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const previousMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    
    console.log('Date ranges:', {
      currentMonthStart: currentMonthStart.toISOString().slice(0, 10),
      previousMonthStart: previousMonthStart.toISOString().slice(0, 10)
    });

    const results = {};

    try {
      // 1. TOTAL BOOKINGS STATS
      console.log('🔍 Getting booking statistics...');
      
      const bookingStatsQuery = `
        SELECT 
          COUNT(*) as total_bookings,
          COUNT(CASE WHEN created_at >= $1 THEN 1 END) as current_month_bookings,
          COUNT(CASE WHEN created_at >= $2 AND created_at < $1 THEN 1 END) as previous_month_bookings
        FROM bookings
      `;
      
      const bookingStatsResult = await pool.query(bookingStatsQuery, [currentMonthStart, previousMonthStart]);
      const bookingStats = bookingStatsResult.rows[0];
      
      results.totalBookings = parseInt(bookingStats.total_bookings || 0);
      results.currentMonthBookings = parseInt(bookingStats.current_month_bookings || 0);
      results.previousMonthBookings = parseInt(bookingStats.previous_month_bookings || 0);
      
      console.log('📊 Booking Stats:', {
        total: results.totalBookings,
        current: results.currentMonthBookings,
        previous: results.previousMonthBookings
      });

      // 2. REVENUE STATS
      console.log('🔍 Getting revenue statistics...');
      
      const revenueStatsQuery = `
        SELECT 
          COALESCE(SUM(total_amount), 0) as total_revenue,
          COALESCE(SUM(CASE WHEN created_at >= $1 THEN total_amount ELSE 0 END), 0) as current_month_revenue,
          COALESCE(SUM(CASE WHEN created_at >= $2 AND created_at < $1 THEN total_amount ELSE 0 END), 0) as previous_month_revenue
        FROM bookings 
        WHERE payment_status IN ('paid', 'completed')
      `;
      
      const revenueStatsResult = await pool.query(revenueStatsQuery, [currentMonthStart, previousMonthStart]);
      const revenueStats = revenueStatsResult.rows[0];
      
      results.totalRevenue = parseFloat(revenueStats.total_revenue || 0);
      results.currentMonthRevenue = parseFloat(revenueStats.current_month_revenue || 0);
      results.previousMonthRevenue = parseFloat(revenueStats.previous_month_revenue || 0);
      
      console.log('💰 Revenue Stats:', {
        total: results.totalRevenue,
        current: results.currentMonthRevenue,
        previous: results.previousMonthRevenue
      });

      // 3. VEHICLE STATS
      console.log('🔍 Getting vehicle statistics...');
      
      const vehicleStatsQuery = `
        SELECT 
          COUNT(*) as total_vehicles,
          COUNT(CASE WHEN status = 'available' THEN 1 END) as available_vehicles,
          COUNT(CASE WHEN status = 'rented' THEN 1 END) as rented_vehicles,
          COUNT(CASE WHEN status = 'maintenance' THEN 1 END) as maintenance_vehicles
        FROM vehicles
      `;
      
      const vehicleStatsResult = await pool.query(vehicleStatsQuery);
      const vehicleStats = vehicleStatsResult.rows[0];
      
      results.totalVehicles = parseInt(vehicleStats.total_vehicles || 0);
      results.availableVehicles = parseInt(vehicleStats.available_vehicles || 0);
      results.rentedVehicles = parseInt(vehicleStats.rented_vehicles || 0);
      results.maintenanceVehicles = parseInt(vehicleStats.maintenance_vehicles || 0);
      
      // Calculate utilization rate
      const activeVehicles = results.availableVehicles + results.rentedVehicles;
      results.utilizationRate = activeVehicles > 0 
        ? Math.round((results.rentedVehicles / activeVehicles) * 100) 
        : 0;
      
      console.log('🚗 Vehicle Stats:', {
        total: results.totalVehicles,
        available: results.availableVehicles,
        rented: results.rentedVehicles,
        maintenance: results.maintenanceVehicles,
        utilization: results.utilizationRate
      });

      // 4. USER STATS
      console.log('🔍 Getting user statistics...');
      
      const userStatsQuery = `
        SELECT 
          COUNT(*) as total_users,
          COUNT(CASE WHEN created_at >= $1 THEN 1 END) as new_users_this_month,
          COUNT(CASE WHEN role = 'customer' THEN 1 END) as customers,
          COUNT(CASE WHEN role = 'owner' THEN 1 END) as owners
        FROM users
      `;
      
      const userStatsResult = await pool.query(userStatsQuery, [currentMonthStart]);
      const userStats = userStatsResult.rows[0];
      
      results.totalUsers = parseInt(userStats.total_users || 0);
      results.newUsersThisMonth = parseInt(userStats.new_users_this_month || 0);
      results.customers = parseInt(userStats.customers || 0);
      results.owners = parseInt(userStats.owners || 0);
      
      console.log('👥 User Stats:', {
        total: results.totalUsers,
        newThisMonth: results.newUsersThisMonth,
        customers: results.customers,
        owners: results.owners
      });

    } catch (queryError) {
      console.error('❌ Query error in dashboard stats:', queryError);
      throw queryError;
    }

    // Calculate percentage changes
    const bookingChange = results.previousMonthBookings > 0 
      ? ((results.currentMonthBookings - results.previousMonthBookings) / results.previousMonthBookings * 100).toFixed(1) 
      : results.currentMonthBookings > 0 ? 100 : 0;

    const revenueChange = results.previousMonthRevenue > 0 
      ? ((results.currentMonthRevenue - results.previousMonthRevenue) / results.previousMonthRevenue * 100).toFixed(1) 
      : results.currentMonthRevenue > 0 ? 100 : 0;

    // Format final response
    const dashboardStats = {
      totalBookings: {
        value: results.totalBookings,
        change: `${bookingChange >= 0 ? '+' : ''}${bookingChange}% this month`,
        changeType: bookingChange >= 0 ? 'positive' : 'negative',
        currentMonth: results.currentMonthBookings,
        previousMonth: results.previousMonthBookings
      },
      totalRevenue: {
        value: results.totalRevenue,
        change: `${revenueChange >= 0 ? '+' : ''}${revenueChange}% this month`,
        changeType: revenueChange >= 0 ? 'positive' : 'negative',
        currentMonth: results.currentMonthRevenue,
        previousMonth: results.previousMonthRevenue
      },
      activeVehicles: {
        value: results.totalVehicles,
        change: `${results.utilizationRate}% utilization`,
        changeType: 'neutral',
        available: results.availableVehicles,
        rented: results.rentedVehicles,
        maintenance: results.maintenanceVehicles
      },
      activeUsers: {
        value: results.totalUsers,
        change: `+${results.newUsersThisMonth} new users`,
        changeType: 'positive',
        customers: results.customers,
        owners: results.owners,
        newThisMonth: results.newUsersThisMonth
      }
    };

    console.log('=== FINAL DASHBOARD STATS ===');
    console.log('Total Bookings:', dashboardStats.totalBookings.value, dashboardStats.totalBookings.change);
    console.log('Total Revenue:', dashboardStats.totalRevenue.value, dashboardStats.totalRevenue.change);
    console.log('Active Vehicles:', dashboardStats.activeVehicles.value, dashboardStats.activeVehicles.change);
    console.log('Active Users:', dashboardStats.activeUsers.value, dashboardStats.activeUsers.change);

    successResponse(res, dashboardStats, 'Dashboard statistics retrieved successfully');
  } catch (err) {
    console.error('❌ Database error in dashboard stats:', err);
    errorResponse(res, 'Failed to retrieve dashboard statistics', 500);
  }
});

// Get trends data for charts (FIXED VERSION)
router.get('/stats/trends', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { period = '8' } = req.query;
    const periodInt = parseInt(period) || 8;
    
    console.log('🔍 Getting trends data for', periodInt, 'months');
    
    const trendsQuery = `
      WITH months AS (
        SELECT 
          DATE_TRUNC('month', generate_series(
            CURRENT_DATE - INTERVAL '${periodInt} months',
            CURRENT_DATE,
            '1 month'::INTERVAL
          )) as month
      )
      SELECT 
        TO_CHAR(m.month, 'Mon') as month,
        EXTRACT(MONTH FROM m.month) as month_num,
        EXTRACT(YEAR FROM m.month) as year_num,
        COALESCE(COUNT(b.id), 0) as bookings,
        COALESCE(SUM(CASE WHEN b.payment_status IN ('paid', 'completed') THEN b.total_amount ELSE 0 END), 0) as revenue
      FROM months m
      LEFT JOIN bookings b ON DATE_TRUNC('month', b.created_at) = m.month
      GROUP BY m.month
      ORDER BY m.month ASC
    `;

    const result = await pool.query(trendsQuery);
    const trendsData = result.rows.map(row => ({
      month: row.month,
      bookings: parseInt(row.bookings),
      revenue: Math.round(parseFloat(row.revenue) / 1000), // Convert to thousands
      month_num: parseInt(row.month_num),
      year_num: parseInt(row.year_num)
    }));

    console.log('📈 Trends data:', trendsData);

    successResponse(res, trendsData, 'Trends data retrieved successfully');
  } catch (err) {
    console.error('❌ Database error in trends:', err);
    errorResponse(res, 'Failed to retrieve trends data', 500);
  }
});

// Get top rented vehicles (FIXED VERSION)
router.get('/stats/top-vehicles', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { limit = 5 } = req.query;
    const limitInt = parseInt(limit) || 5;
    
    console.log('🔍 Getting top', limitInt, 'vehicles');
    
    const query = `
      SELECT 
        v.id,
        v.make,
        v.model,
        v.year,
        v.type,
        COUNT(b.id) as total_bookings,
        COALESCE(SUM(CASE WHEN b.payment_status IN ('paid', 'completed') THEN b.total_amount ELSE 0 END), 0) as total_revenue
      FROM vehicles v
      LEFT JOIN bookings b ON v.id = b.vehicle_id
      GROUP BY v.id, v.make, v.model, v.year, v.type
      HAVING COUNT(b.id) > 0
      ORDER BY COUNT(b.id) DESC, total_revenue DESC
      LIMIT $1
    `;

    const result = await pool.query(query, [limitInt]);
    const topVehicles = result.rows.map((row, index) => ({
      id: row.id,
      name: `${row.make} ${row.model}`,
      year: row.year,
      type: row.type,
      bookings: parseInt(row.total_bookings),
      revenue: parseFloat(row.total_revenue || 0),
      color: getVehicleColor(index)
    }));

    console.log('🏆 Top vehicles:', topVehicles);

    successResponse(res, topVehicles, 'Top vehicles retrieved successfully');
  } catch (err) {
    console.error('❌ Database error in top vehicles:', err);
    errorResponse(res, 'Failed to retrieve top vehicles', 500);
  }
});

// Get system overview (FIXED VERSION)
router.get('/overview', authenticateToken, requireAdmin, async (req, res) => {
  try {
    console.log('🔍 Getting system overview...');
    
    const queries = [
      // User statistics
      `SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN role = 'customer' THEN 1 END) as customers,
        COUNT(CASE WHEN role = 'owner' THEN 1 END) as owners,
        COUNT(CASE WHEN role = 'admin' THEN 1 END) as admins,
        COUNT(CASE WHEN created_at >= DATE_TRUNC('month', CURRENT_DATE) THEN 1 END) as new_this_month
       FROM users`,
      
      // Vehicle statistics
      `SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'available' THEN 1 END) as available,
        COUNT(CASE WHEN status = 'rented' THEN 1 END) as rented,
        COUNT(CASE WHEN status = 'maintenance' THEN 1 END) as maintenance
       FROM vehicles`,
      
      // Booking statistics
      `SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
        COUNT(CASE WHEN status = 'confirmed' THEN 1 END) as confirmed,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
        COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled
       FROM bookings`,
      
      // Revenue statistics
      `SELECT 
        COALESCE(SUM(total_amount), 0) as total_revenue,
        COALESCE(SUM(CASE WHEN created_at >= DATE_TRUNC('month', CURRENT_DATE) THEN total_amount ELSE 0 END), 0) as monthly_revenue
       FROM bookings 
       WHERE payment_status IN ('paid', 'completed')`
    ];

    const results = await Promise.all(queries.map(q => pool.query(q)));

    const overview = {
      users: {
        total: parseInt(results[0].rows[0].total || 0),
        customers: parseInt(results[0].rows[0].customers || 0),
        owners: parseInt(results[0].rows[0].owners || 0),
        admins: parseInt(results[0].rows[0].admins || 0),
        newThisMonth: parseInt(results[0].rows[0].new_this_month || 0)
      },
      vehicles: {
        total: parseInt(results[1].rows[0].total || 0),
        available: parseInt(results[1].rows[0].available || 0),
        rented: parseInt(results[1].rows[0].rented || 0),
        maintenance: parseInt(results[1].rows[0].maintenance || 0),
        utilizationRate: 0 // Calculate below
      },
      bookings: {
        total: parseInt(results[2].rows[0].total || 0),
        completed: parseInt(results[2].rows[0].completed || 0),
        confirmed: parseInt(results[2].rows[0].confirmed || 0),
        pending: parseInt(results[2].rows[0].pending || 0),
        cancelled: parseInt(results[2].rows[0].cancelled || 0)
      },
      revenue: {
        total: parseFloat(results[3].rows[0].total_revenue || 0),
        monthly: parseFloat(results[3].rows[0].monthly_revenue || 0)
      }
    };

    // Calculate utilization rate
    const activeVehicles = overview.vehicles.available + overview.vehicles.rented;
    overview.vehicles.utilizationRate = activeVehicles > 0 
      ? Math.round((overview.vehicles.rented / activeVehicles) * 100) 
      : 0;

    console.log('📊 System Overview:', overview);

    successResponse(res, overview, 'System overview retrieved successfully');
  } catch (err) {
    console.error('❌ Database error in overview:', err);
    errorResponse(res, 'Failed to retrieve system overview', 500);
  }
});

// Get system notifications/alerts (FIXED VERSION)
router.get('/notifications', authenticateToken, requireAdmin, async (req, res) => {
  try {
    console.log('🔍 Getting system notifications...');
    
    const results = {};

    try {
      // Vehicles needing maintenance
      const maintenanceResult = await pool.query(
        `SELECT COUNT(*) as count FROM vehicles WHERE status = 'maintenance'`
      );
      results.maintenanceVehicles = parseInt(maintenanceResult.rows[0]?.count || 0);

      // Overdue bookings
      const overdueResult = await pool.query(
        `SELECT COUNT(*) as count FROM bookings 
         WHERE status IN ('confirmed', 'active') AND end_date < CURRENT_DATE`
      );
      results.overdueBookings = parseInt(overdueResult.rows[0]?.count || 0);

      // Pending payments
      const pendingPaymentsResult = await pool.query(
        `SELECT COUNT(*) as count FROM bookings 
         WHERE payment_status = 'pending' AND created_at < CURRENT_DATE - INTERVAL '24 hours'`
      );
      results.pendingPayments = parseInt(pendingPaymentsResult.rows[0]?.count || 0);

      // Recent bookings (last 24 hours)
      const recentBookingsResult = await pool.query(
        `SELECT COUNT(*) as count FROM bookings 
         WHERE created_at >= CURRENT_DATE - INTERVAL '24 hours'`
      );
      results.recentBookings = parseInt(recentBookingsResult.rows[0]?.count || 0);

      // Support tickets (if table exists)
      try {
        const supportResult = await pool.query(
          `SELECT COUNT(*) as count FROM support_requests 
           WHERE status = 'open' AND created_at >= CURRENT_DATE - INTERVAL '24 hours'`
        );
        results.newSupportTickets = parseInt(supportResult.rows[0]?.count || 0);
      } catch (supportError) {
        console.log('Support requests table not found, setting to 0');
        results.newSupportTickets = 0;
      }

    } catch (queryError) {
      console.error('Query error in notifications:', queryError);
      // Set safe defaults
      results.maintenanceVehicles = 0;
      results.overdueBookings = 0;
      results.pendingPayments = 0;
      results.recentBookings = 0;
      results.newSupportTickets = 0;
    }

    console.log('🔔 Notifications:', results);

    successResponse(res, results, 'Notifications retrieved successfully');
  } catch (err) {
    console.error('❌ Database error in notifications:', err);
    errorResponse(res, 'Failed to retrieve notifications', 500);
  }
});

// Helper function for vehicle colors
function getVehicleColor(index) {
  const colors = [
    'bg-red-200 text-red-700',
    'bg-blue-200 text-blue-700', 
    'bg-green-200 text-green-700',
    'bg-yellow-200 text-yellow-700',
    'bg-purple-200 text-purple-700',
    'bg-pink-200 text-pink-700',
    'bg-indigo-200 text-indigo-700'
  ];
  return colors[index % colors.length];
}

module.exports = router;

