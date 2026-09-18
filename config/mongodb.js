const { MongoClient, ObjectId } = require('mongodb');

const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
const databaseName = process.env.MONGODB_DB || process.env.MONGO_DB || 'autofleet';

const client = uri ? new MongoClient(uri) : null;
let database;

async function connectMongo() {
  if (!uri) {
    throw new Error('Missing MONGODB_URI (or MONGO_URI) in backend/.env');
  }

  if (!database) {
    if (!client) {
      throw new Error('MongoDB client is not configured');
    }
    await client.connect();
    database = client.db(databaseName);
    await database.command({ ping: 1 });
    console.log(`Connected to MongoDB database: ${databaseName}`);
  }

  return database;
}

function getMongoDatabase() {
  if (!database) {
    throw new Error('MongoDB is not connected. Call connectMongo() first.');
  }

  return database;
}

async function closeMongo() {
  if (client) await client.close();
  database = undefined;
}

function toObjectId(value) {
  if (value instanceof ObjectId) return value;
  if (!value) return null;
  return ObjectId.isValid(value) ? new ObjectId(value) : null;
}

module.exports = {
  client,
  connectMongo,
  getMongoDatabase,
  closeMongo,
  toObjectId,
  ObjectId
};
