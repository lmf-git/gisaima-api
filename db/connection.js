import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/gisaima';

let _client;
let _db;

export async function connect() {
  // Pool sized for a single dyno against a shared/free-tier cluster (M0 caps at
  // 500 connections): keep a small pool and let idle sockets drop so we stay a
  // light tenant. maxPoolSize is overridable for when the cluster is upgraded.
  _client = new MongoClient(MONGO_URI, {
    maxPoolSize:             Number(process.env.MONGO_MAX_POOL) || 20,
    minPoolSize:             0,
    maxIdleTimeMS:           60_000,
    serverSelectionTimeoutMS: 10_000,
  });
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

/** Close the Mongo client on shutdown (releases pooled connections cleanly). */
export async function close() {
  if (_client) { await _client.close(); _client = null; _db = null; }
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

  // Gameplay collections that grow with players and are queried by worldId/uid
  // (not just _id) — without these they collection-scan as a world fills up.
  // `lives` is the hottest (character lookups on many action paths); the rest
  // back per-world list/membership queries and the bank tick.
  await db.collection('lives').createIndex({ worldId: 1, uid: 1 });
  await db.collection('bank_loans').createIndex({ worldId: 1, status: 1 });
  await db.collection('bounties').createIndex({ worldId: 1, targetUid: 1, status: 1 });
  await db.collection('trails').createIndex({ worldId: 1, status: 1 });
  await db.collection('friends').createIndex({ worldId: 1, users: 1 });
  await db.collection('houses').createIndex({ worldId: 1 });
  await db.collection('houses').createIndex({ worldId: 1, 'members.uid': 1 });

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
