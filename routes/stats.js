import { apiError } from '../core/auth.js';
import * as stats from '../db/stats.js';

export async function getMine(db, worldId, uid) {
  if (!uid) return null;
  return stats.getFor(db, worldId, uid);
}

export async function getForPlayer(db, worldId, uid) {
  return stats.getFor(db, worldId, uid);
}

export async function postFlag(db, auth, worldId, body) {
  if (!body?.field) throw apiError(400, 'field required');
  try {
    await stats.setFlag(db, worldId, auth.uid, body.field, body.value);
    return { ok: true };
  } catch (e) {
    throw apiError(400, e.message);
  }
}

export async function getWealth(db, worldId) {
  return { items: await stats.wealthRankings(db, worldId, 50) };
}
