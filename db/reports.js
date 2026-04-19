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

export async function markReportRead(db, reportId, playerId) {
  return db.collection('reports').updateOne(
    { _id: new ObjectId(reportId), playerId },
    { $set: { read: true } }
  );
}
