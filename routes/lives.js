import { apiError } from '../core/auth.js';
import * as lives from '../db/lives.js';
import { Ops } from '../lib/ops.js';

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

export async function postMarry(db, auth, worldId, body) {
  if (!body?.lifeIdA || !body?.lifeIdB) throw apiError(400, 'lifeIdA and lifeIdB required');
  try {
    const r = await lives.marry(db, worldId, auth.uid, body.lifeIdA, body.lifeIdB);
    // Announce the wedding — a celebration at the structure if held at one.
    const ops = new Ops();
    const [n1, n2] = r.names;
    ops.chat(worldId, {
      location: r.location,
      text: r.structureName
        ? `💍 A wedding at ${r.structureName}: ${n1} and ${n2} are wed!`
        : `💍 ${n1} and ${n2} are wed beneath the open sky!`,
      timestamp: Date.now(),
      type: 'event',
      category: 'player',
      userId: auth.uid,
    });
    await ops.flush(db);
    return { ok: true, ...r };
  } catch (e) {
    throw apiError(400, e.message);
  }
}

export async function getHeirs(db, worldId, uid) {
  if (!uid) return { items: [] };
  return { items: await lives.listHeirs(db, worldId, uid) };
}

// Living, on-map characters the player can switch the camera between.
export async function getActive(db, worldId, uid) {
  if (!uid) return { items: [] };
  const items = (await lives.listActive(db, worldId, uid)).filter(l => l.alive);
  return { items };
}

// Switch which character the map follows / actions default to.
export async function postControl(db, auth, worldId, body) {
  if (!body?.lifeId) throw apiError(400, 'lifeId required');
  try {
    const life = await lives.setControlled(db, worldId, auth.uid, body.lifeId);
    return { success: true, lifeId: String(life._id), name: life.name };
  } catch (e) {
    throw apiError(400, e.message);
  }
}

export function getEthnicities() {
  return { items: lives.ETHNICITIES };
}
