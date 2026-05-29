/**
 * Set per-structure access tiers. Only the structure owner may set them.
 *
 * Body:
 *   { worldId, tileX, tileY, access: { build, recruit, deposit } }
 *
 * Each tier must be one of: owner | friends | tribe | public.
 */
import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { Ops } from '../../lib/ops.js';
import { ACCESS_ACTIONS, isValidTier } from '../../structures/access.js';

function err(status, message) {
  return Object.assign(new Error(message), { status });
}

function _clean(access) {
  const out = {};
  for (const k of ACCESS_ACTIONS) {
    const v = access?.[k];
    if (typeof v === 'string' && isValidTier(v)) out[k] = v;
  }
  return out;
}

export default async function setStructureAccess({ uid, data, db }) {
  const { worldId, tileX, tileY, access } = data || {};
  if (!worldId || typeof tileX !== 'number' || typeof tileY !== 'number') {
    throw err(400, 'worldId, tileX, tileY required');
  }
  if (!access || typeof access !== 'object') throw err(400, 'access object required');

  const chunkKey = getChunkKey(tileX, tileY);
  const tileKey  = `${tileX},${tileY}`;
  const chunk = await db.collection('chunks').findOne(
    { worldId, chunkKey },
    { projection: { [`tiles.${tileKey}.structure`]: 1 } }
  );
  const structure = chunk?.tiles?.[tileKey]?.structure;
  if (!structure) throw err(404, 'no structure on this tile');
  if (structure.type === 'spawn') throw err(409, 'spawn access is governed by race, not settings');
  if (structure.owner !== uid) throw err(403, 'only the owner may set access');

  const cleaned = { ...(structure.access || {}), ..._clean(access) };
  const ops = new Ops();
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.access`, cleaned);
  await ops.flush(db);

  return { ok: true, access: cleaned };
}
