import { getPlayerHoldings } from '../db/holdings.js';

// GET /worlds/:worldId/holdings — the authed player's structures and unit
// groups with their stored items and locations.
export async function getHoldings(db, worldId, uid) {
  if (!uid) return { structures: [], groups: [] };
  return getPlayerHoldings(db, worldId, uid);
}
