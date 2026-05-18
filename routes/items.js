import { apiError } from '../core/auth.js';
import * as items from '../db/items.js';

export async function getAt(db, worldId, tileKey) {
  const [xs, ys] = (tileKey || '').split(',');
  const x = Number(xs), y = Number(ys);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw apiError(400, 'tileKey required as x,y');
  const drops = await items.listAt(db, worldId, x, y);
  return { drops };
}

export async function postDrop(db, auth, worldId, body) {
  try {
    return await items.dropAtCurrentLocation(db, worldId, auth.uid, body?.items);
  } catch (e) {
    throw apiError(400, e.message);
  }
}

export async function postPickup(db, auth, worldId, body) {
  try {
    return await items.pickupAtCurrentLocation(db, worldId, auth.uid, body?.items);
  } catch (e) {
    throw apiError(400, e.message);
  }
}
