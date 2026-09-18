require('dotenv').config();

const { Pool } = require('pg');
const { MongoClient, ObjectId } = require('mongodb');

const postgresPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  user: process.env.PGUSER || 'postgres',
  host: process.env.PGHOST || 'localhost',
  database: process.env.PGDATABASE || 'autofleet',
  password: process.env.PGPASSWORD || 'password',
  port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
  ssl: process.env.PGHOST && process.env.PGHOST.includes('render.com')
    ? { rejectUnauthorized: false }
    : false
});

const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
const mongoDatabaseName = process.env.MONGODB_DB || process.env.MONGO_DB || 'autofleet';

if (!mongoUri) {
  throw new Error('Missing MONGODB_URI (or MONGO_URI) in backend/.env');
}

const tableNames = [
  'users',
  'vehicles',
  'bookings',
  'feedback',
  'notifications',
  'vehicle_tracking',
  'vehicle_devices',
  'vehicle_alert_settings',
  'vehicle_alert_events',
  'work_order_templates',
  'work_orders',
  'subscriptions',
  'support_requests',
  'support_responses'
];

const foreignKeyTargets = {
  user_id: 'users',
  owner_id: 'users',
  customer_id: 'users',
  vendor_id: 'users',
  assignee_id: 'users',
  vehicle_id: 'vehicles',
  booking_id: 'bookings',
  template_id: 'work_order_templates',
  support_request_id: 'support_requests'
};

function convertValue(value, targetCollection, idMaps) {
  if (value === null || value === undefined || !targetCollection) return value;
  const targetMap = idMaps.get(targetCollection);
  if (!targetMap) return value;
  return targetMap.get(String(value)) || value;
}

async function getTables() {
  const result = await postgresPool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`
  );

  return result.rows
    .map((row) => row.table_name)
    .filter((tableName) => tableNames.includes(tableName));
}

async function migrate() {
  const mongoClient = new MongoClient(mongoUri);
  const idMaps = new Map();

  try {
    await mongoClient.connect();
    const mongoDatabase = mongoClient.db(mongoDatabaseName);
    const tables = await getTables();

    if (tables.length === 0) {
      throw new Error('No supported PostgreSQL tables were found.');
    }

    for (const tableName of tables) {
      const result = await postgresPool.query(`SELECT * FROM ${tableName}`);
      const idMap = new Map();

      for (const row of result.rows) {
        if (row.id !== undefined && row.id !== null) {
          idMap.set(String(row.id), new ObjectId());
        }
      }

      idMaps.set(tableName, idMap);
    }

    for (const tableName of tables) {
      const result = await postgresPool.query(`SELECT * FROM ${tableName}`);
      const documents = result.rows.map((row) => {
        const document = { ...row };
        const newId = idMaps.get(tableName).get(String(row.id)) || new ObjectId();

        document._id = newId;
        if (row.id !== undefined) document.legacyId = row.id;
        delete document.id;

        for (const [fieldName, targetCollection] of Object.entries(foreignKeyTargets)) {
          if (Object.prototype.hasOwnProperty.call(document, fieldName)) {
            document[fieldName] = convertValue(document[fieldName], targetCollection, idMaps);
          }
        }

        return document;
      });

      const collection = mongoDatabase.collection(tableName);
      await collection.deleteMany({});
      if (documents.length > 0) {
        await collection.insertMany(documents, { ordered: false });
      }

      console.log(`Migrated ${documents.length} ${tableName} records`);
    }

    await mongoDatabase.collection('users').createIndex({ email: 1 }, { unique: true });
    await mongoDatabase.collection('vehicles').createIndex({ license_plate: 1 }, { unique: true });
    console.log(`Migration completed in MongoDB database: ${mongoDatabaseName}`);
  } finally {
    await postgresPool.end();
    await mongoClient.close();
  }
}

migrate().catch((error) => {
  console.error('PostgreSQL to MongoDB migration failed:', error.message);
  process.exitCode = 1;
});
