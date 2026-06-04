import { getReportsFor, resolveHouseTribe, markReportRead } from '../db/reports.js';

export async function getReports(db, auth, worldId) {
  const { houseId, tribeId } = await resolveHouseTribe(db, worldId, auth.uid);
  return getReportsFor(db, worldId, { uid: auth.uid, houseId, tribeId });
}

export async function postReportRead(db, auth, worldId, reportId) {
  await markReportRead(db, reportId, auth.uid);
  return { success: true };
}
