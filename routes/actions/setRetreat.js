/**
 * Update a group's rule of march after mobilisation — the loss percentage at
 * which it automatically flees battle (`fleeAtLosses`, enforced by battleTick).
 * 0 disables auto-flee; otherwise clamped to 1..99.
 */
import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { Ops } from '../../lib/ops.js';

export async function setRetreat({ uid, data, db }) {
  const { worldId, x, y, groupId, fleeAtLosses } = data || {};
  if (!worldId || !groupId || x === undefined || y === undefined) {
    throw err(400, 'worldId, groupId, x, y required');
  }

  const chunkKey = getChunkKey(x, y);
  const tileKey  = `${x},${y}`;
  const chunkDoc = await db.collection('chunks').findOne({ worldId, chunkKey });
  const group    = chunkDoc?.tiles?.[tileKey]?.groups?.[groupId];

  if (!group)              throw err(404, 'Group not found at specified location');
  if (group.owner !== uid) throw err(403, 'You can only set retreat rules for your own groups');

  const raw = Number(fleeAtLosses);
  const clamped = !Number.isFinite(raw) || raw <= 0 ? 0 : Math.max(1, Math.min(99, Math.round(raw)));

  const ops = new Ops();
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.fleeAtLosses`, clamped);
  await ops.flush(db);

  return { success: true, fleeAtLosses: clamped };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export default setRetreat;
