/**
 * Set tax rates on a structure (per the design doc's coffers/taxes idea).
 * Only the structure owner may set them.
 *
 * Body:
 *   { worldId, tileX, tileY, taxes: { trade, building, mine, farm } }
 *
 * Per-category taxes are clamped to 0..50%.
 */
import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { Ops } from '../../lib/ops.js';

function err(status, message) {
  return Object.assign(new Error(message), { status });
}

const CATEGORIES = ['trade', 'building', 'mine', 'farm'];

function _clean(taxes) {
  const out = {};
  for (const k of CATEGORIES) {
    const v = Number(taxes?.[k]);
    if (Number.isFinite(v)) out[k] = Math.max(0, Math.min(50, Math.round(v)));
  }
  return out;
}

export default async function setStructureTaxes({ uid, data, db }) {
  const { worldId, tileX, tileY, taxes } = data || {};
  if (!worldId || typeof tileX !== 'number' || typeof tileY !== 'number') {
    throw err(400, 'worldId, tileX, tileY required');
  }
  if (!taxes || typeof taxes !== 'object') throw err(400, 'taxes object required');

  const chunkKey = getChunkKey(tileX, tileY);
  const tileKey  = `${tileX},${tileY}`;
  const chunk = await db.collection('chunks').findOne(
    { worldId, chunkKey },
    { projection: { [`tiles.${tileKey}.structure`]: 1 } }
  );
  const structure = chunk?.tiles?.[tileKey]?.structure;
  if (!structure) throw err(404, 'no structure on this tile');
  if (structure.owner !== uid) throw err(403, 'only the steward may set taxes');

  const cleaned = _clean(taxes);
  const ops = new Ops();
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.taxes`, cleaned);
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.taxesSetAt`, new Date());
  await ops.flush(db);

  return { ok: true, taxes: cleaned };
}
