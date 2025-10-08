const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.PGUSER || 'postgres',
  host: process.env.PGHOST || 'localhost',
  database: process.env.PGDATABASE || 'autofleet',
  password: process.env.PGPASSWORD || 'password',
  port: process.env.PGPORT ? parseInt(process.env.PGPORT) : 5432,
});

(async () => {
  const client = await pool.connect();
  try {
    console.log('Connected to PostgreSQL database');
    await initializeDatabase(client);
  } catch (err) {
    console.error('Error connecting to PostgreSQL:', err.stack);
  } finally {
    client.release();
  }
})();
    console.log('Connected to PostgreSQL database');
async function initializeDatabase(client) {
  try {
    await client.query(`
      CREATE TYPE user_role AS ENUM ('customer', 'owner', 'admin');
    `).catch(() => {});
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        first_name VARCHAR(100) NOT NULL,
        last_name VARCHAR(100) NOT NULL,
        phone VARCHAR(20),
        role user_role DEFAULT 'customer',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  // ...existing code...
    // Vehicles table
    await client.query(`
      CREATE TYPE vehicle_type AS ENUM ('sedan', 'suv', 'van', 'truck');
    `).catch(() => {});
    await client.query(`
      CREATE TYPE transmission_type AS ENUM ('manual', 'automatic');
    `).catch(() => {});
    await client.query(`
      CREATE TYPE fuel_type_enum AS ENUM ('gasoline', 'diesel', 'electric', 'hybrid');
    `).catch(() => {});
    await client.query(`
      CREATE TYPE vehicle_status AS ENUM ('available', 'rented', 'maintenance', 'inactive');
    `).catch(() => {});
    await client.query(`
      CREATE TABLE IF NOT EXISTS vehicles (
        id SERIAL PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id),
        make VARCHAR(100) NOT NULL,
        model VARCHAR(100) NOT NULL,
        year INTEGER NOT NULL,
        type vehicle_type NOT NULL,
        license_plate VARCHAR(20) UNIQUE NOT NULL,
        color VARCHAR(50),
        seats INTEGER,
        transmission transmission_type DEFAULT 'automatic',
        fuel_type fuel_type_enum DEFAULT 'gasoline',
        daily_rate NUMERIC(10,2) NOT NULL,
        description TEXT,
        features JSONB,
        images JSONB,
        status vehicle_status DEFAULT 'available',
        location_lat NUMERIC(10,8),
        location_lng NUMERIC(11,8),
        location_address TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  // ...existing code...
    // Bookings table
    await client.query(`
      CREATE TYPE booking_status AS ENUM ('pending', 'confirmed', 'active', 'completed', 'cancelled');
    `).catch(() => {});
    await client.query(`
      CREATE TYPE payment_status_enum AS ENUM ('pending', 'paid', 'refunded');
    `).catch(() => {});
    await client.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER NOT NULL REFERENCES users(id),
        vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        pickup_location TEXT,
        dropoff_location TEXT,
        total_amount NUMERIC(10,2) NOT NULL,
        status booking_status DEFAULT 'pending',
        payment_status payment_status_enum DEFAULT 'pending',
        payment_method VARCHAR(50),
        payment_transaction_id VARCHAR(255),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  // ...existing code...
    // Feedback table
    await client.query(`
      CREATE TABLE IF NOT EXISTS feedback (
        id SERIAL PRIMARY KEY,
        booking_id INTEGER NOT NULL REFERENCES bookings(id),
        customer_id INTEGER NOT NULL REFERENCES users(id),
        vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
        rating INTEGER CHECK(rating >= 1 AND rating <= 5) NOT NULL,
        comment TEXT,
        service_rating INTEGER CHECK(service_rating >= 1 AND service_rating <= 5),
        vehicle_condition_rating INTEGER CHECK(vehicle_condition_rating >= 1 AND vehicle_condition_rating <= 5),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  // ...existing code...
    // Notifications table
    await client.query(`
      CREATE TYPE notification_type AS ENUM ('booking', 'payment', 'reminder', 'system');
    `).catch(() => {});
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        type notification_type NOT NULL,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  // ...existing code...
    // Vehicle tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS vehicle_tracking (
        id SERIAL PRIMARY KEY,
        vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
        booking_id INTEGER REFERENCES bookings(id),
        latitude NUMERIC(10,8),
        longitude NUMERIC(11,8),
        speed NUMERIC(5,2),
        fuel_level NUMERIC(5,2),
        mileage NUMERIC(10,2),
        status VARCHAR(50),
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('Database tables initialized');
  } catch (err) {
    console.error('Error initializing database:', err);
  } finally {
  }
}

module.exports = pool;

