import { getPlayerReports, markReportRead } from '../db/reports.js';

export async function getReports(db, auth, worldId) {
  const rows = await getPlayerReports(db, worldId, auth.uid);
  return rows.map(r => ({ ...r, _id: r._id.toString() }));
}

export async function postReportRead(db, auth, worldId, reportId) {
  await markReportRead(db, reportId, auth.uid);
  return { success: true };
}
