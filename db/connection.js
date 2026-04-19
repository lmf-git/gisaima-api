import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/gisaima';

let _client;
let _db;

export async function connect() {
  _client = new MongoClient(MONGO_URI);
  await _client.connect();
  _db = _client.db(); // Uses the DB name from the URI
  await _ensureIndexes(_db);
  console.log(`MongoDB connected to: ${_db.databaseName}`);
  return _db;
}

export function getDb() {
  if (!_db) throw new Error('DB not connected — call connect() first');
  return _db;
}

async function _ensureIndexes(db) {
  await db.collection('chunks').createIndex({ worldId: 1, chunkKey: 1 }, { unique: true });
  await db.collection('chat').createIndex({ worldId: 1, timestamp: -1 });
  await db.collection('users').createIndex({ email: 1 }, { unique: true, sparse: true });
  await db.collection('reports').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('reports').createIndex({ worldId: 1, playerId: 1, timestamp: -1 });
  await db.collection('tribes').createIndex({ worldId: 1 });
  await db.collection('tribes').createIndex({ worldId: 1, 'members.uid': 1 });
}
