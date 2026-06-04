import { ObjectId } from 'mongodb';

const REPORT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function makeReport(playerId, worldId, data) {
  const now = Date.now();
  return {
    playerId,
    worldId,
    ...data,
    timestamp: now,
    expiresAt: new Date(now + REPORT_TTL_MS),
    read: false,
  };
}

export async function getPlayerReports(db, worldId, playerId) {
  return db.collection('reports')
    .find({ worldId, playerId })
    .sort({ timestamp: -1 })
    .limit(100)
    .toArray();
}

// Reports addressed to the player personally, to their house, or to their tribe.
// Each row is tagged with the `scope` it matched so the UI can group them.
export async function getReportsFor(db, worldId, { uid, houseId, tribeId }) {
  const or = [];
  if (uid)     or.push({ playerId: uid });
  if (houseId) or.push({ houseId });
  if (tribeId) or.push({ tribeId });
  if (!or.length) return [];

  const rows = await db.collection('reports')
    .find({ worldId, $or: or })
    .sort({ timestamp: -1 })
    .limit(150)
    .toArray();

  return rows.map(r => ({
    ...r,
    _id: r._id?.toString(),
    scope: r.tribeId ? 'tribe' : r.houseId ? 'house' : 'personal',
  }));
}

// Resolve which house and tribe a player belongs to. Used when addressing or
// fetching house/tribe-scoped reports.
export async function resolveHouseTribe(db, worldId, uid) {
  if (!uid) return { houseId: null, tribeId: null };
  const [player, tribe] = await Promise.all([
    db.collection('players').findOne(
      { _id: uid },
      { projection: { [`worlds.${worldId}.houseId`]: 1 } }
    ),
    db.collection('tribes').findOne(
      { worldId, 'members.uid': uid },
      { projection: { _id: 1 } }
    ),
  ]);
  return {
    houseId: player?.worlds?.[worldId]?.houseId || null,
    tribeId: tribe?._id ? tribe._id.toString() : null,
  };
}

// Direct insert for house/tribe-addressed reports emitted from async tick paths
// (where the synchronous ops queue isn't convenient). `audience` is one of
// { houseId } or { tribeId }.
export async function insertScopedReport(db, worldId, audience, data) {
  const now = Date.now();
  await db.collection('reports').insertOne({
    worldId,
    ...audience,
    ...data,
    timestamp: now,
    expiresAt: new Date(now + REPORT_TTL_MS),
    read: false,
  });
}

export async function markReportRead(db, reportId, playerId) {
  return db.collection('reports').updateOne(
    { _id: new ObjectId(reportId), playerId },
    { $set: { read: true } }
  );
}
