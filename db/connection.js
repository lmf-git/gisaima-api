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
  // Tick loads only active chunks each interval — this backs that filtered query.
  await db.collection('chunks').createIndex({ worldId: 1, active: 1 });
  await db.collection('chat').createIndex({ worldId: 1, timestamp: -1 });
  await db.collection('users').createIndex({ email: 1 }, { unique: true, sparse: true });
  await db.collection('reports').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('reports').createIndex({ worldId: 1, playerId: 1, timestamp: -1 });
  await db.collection('magic_links').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('tribes').createIndex({ worldId: 1 });
  await db.collection('tribes').createIndex({ worldId: 1, 'members.uid': 1 });

  // The tick (and visibility refresh) query players by `worlds.<id>.morality`
  // every interval. The path is per-world, so we index it per world rather than
  // collection-scanning a growing players collection each tick. Worlds are only
  // created via the seed/restore path (followed by a restart), so enumerating
  // them here covers every world. Sparse: only players with morality are indexed.
  const worldIds = await db.collection('worlds').find({}, { projection: { _id: 1 } }).toArray();
  for (const { _id: worldId } of worldIds) {
    await db.collection('players').createIndex(
      { [`worlds.${worldId}.morality.score`]: 1 },
      { sparse: true, name: `morality_${worldId}` }
    );
  }
}
