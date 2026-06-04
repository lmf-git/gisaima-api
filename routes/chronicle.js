import { getChronicle as getChronicleEntries } from '../db/chronicle.js';

// GET /worlds/:worldId/chronicle — the world's record-breaking history.
export async function getChronicle(db, worldId) {
  return getChronicleEntries(db, worldId);
}
