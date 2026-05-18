import { apiError } from '../core/auth.js';
import * as lives from '../db/lives.js';

export async function getMine(db, worldId, uid) {
  if (!uid) return { items: [] };
  return { items: await lives.listFor(db, worldId, uid) };
}

export async function getDeathFeed(db, worldId) {
  return { items: await lives.deathFeed(db, worldId, 50) };
}

export async function postBirth(db, auth, worldId, body) {
  if (!body?.name) throw apiError(400, 'name required');
  try {
    return await lives.birth(db, { worldId, uid: auth.uid, name: body.name, parentLifeId: body.parentLifeId });
  } catch (e) {
    throw apiError(400, e.message);
  }
}

export async function postRespawn(db, auth, worldId, body) {
  try {
    return await lives.respawn(
      db,
      worldId,
      auth.uid,
      body?.name,
      body?.spawnPoint,
      body?.heirLifeId || null
    );
  } catch (e) {
    throw apiError(400, e.message);
  }
}

export async function postReproduce(db, auth, worldId, body) {
  if (!Array.isArray(body?.parentLifeIds) || body.parentLifeIds.length === 0) {
    throw apiError(400, 'parentLifeIds required');
  }
  try {
    return await lives.reproduce(db, worldId, body.parentLifeIds);
  } catch (e) {
    throw apiError(400, e.message);
  }
}

export async function getHeirs(db, worldId, uid) {
  if (!uid) return { items: [] };
  return { items: await lives.listHeirs(db, worldId, uid) };
}

export function getEthnicities() {
  return { items: lives.ETHNICITIES };
}
