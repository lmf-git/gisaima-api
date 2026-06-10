/**
 * Merge two of your idle groups on the same tile into one (notes: "JOIN UNIT
 * GROUP / MERGE"). Units, items, and passengers combine into the target
 * group; the source group dissolves. Motion is recomputed from the combined
 * units. Both groups must be yours — handing control of your units to another
 * player while keeping ownership is a separate, deeper feature.
 */
import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import UNITS from 'gisaima-shared/definitions/UNITS.js';
import { merge as mergeItems } from 'gisaima-shared/economy/items.js';
import { Ops } from '../../lib/ops.js';
import { patchLife } from '../../db/lives.js';

function motionFor(units) {
  const caps = new Set();
  let hasBoat = false, boatCapacity = 0, nonBoatCount = 0;
  for (const unit of Object.values(units)) {
    if (unit.type === 'player') { caps.add('ground'); nonBoatCount++; continue; }
    const def = UNITS[unit.type] || {};
    (def.motion || ['ground']).forEach(m => caps.add(m));
    if (def.motion?.includes('water') && def.capacity) {
      hasBoat = true; boatCapacity += def.capacity;
    } else nonBoatCount++;
  }
  if (hasBoat) return { motion: ['water'], boatCapacity, transportedUnits: nonBoatCount };
  const m = Array.from(caps);
  return {
    motion: m.length ? (m.includes('water') && !m.includes('ground') && !m.includes('flying') ? ['water'] : m) : ['ground'],
    boatCapacity: 0,
    transportedUnits: 0
  };
}

export async function mergeGroups({ uid, data, db }) {
  const { worldId, x, y, sourceGroupId, targetGroupId } = data || {};
  if (!worldId || !sourceGroupId || !targetGroupId || x === undefined || y === undefined) {
    throw err(400, 'worldId, sourceGroupId, targetGroupId, x, y required');
  }
  if (sourceGroupId === targetGroupId) throw err(400, 'source and target must differ');

  const chunkKey = getChunkKey(x, y);
  const tileKey  = `${x},${y}`;
  const chunkDoc = await db.collection('chunks').findOne({ worldId, chunkKey });
  const tile     = chunkDoc?.tiles?.[tileKey];
  const source   = tile?.groups?.[sourceGroupId];
  const target   = tile?.groups?.[targetGroupId];

  if (!source || !target)        throw err(404, 'Both groups must be on this tile');
  if (source.owner !== uid || target.owner !== uid) {
    throw err(403, 'You can only merge your own groups');
  }
  if (source.status !== 'idle')  throw err(409, `Source group cannot merge while ${source.status}`);
  if (target.status !== 'idle')  throw err(409, `Target group cannot merge while ${target.status}`);
  if (source.passengers && Object.keys(source.passengers).length) {
    throw err(409, 'Unload passengers before merging a boat group');
  }

  const combinedUnits = { ...(target.units || {}), ...(source.units || {}) };
  const combinedItems = mergeItems(target.items || {}, source.items || {});
  const motion        = motionFor(combinedUnits);

  const now = Date.now();
  const ops = new Ops();
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${targetGroupId}.units`, combinedUnits);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${targetGroupId}.items`, combinedItems);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${targetGroupId}.motion`, motion.motion);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${targetGroupId}.boatCapacity`, motion.boatCapacity || null);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${targetGroupId}.transportedUnits`, motion.transportedUnits || null);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${sourceGroupId}`, null);
  ops.chat(worldId, {
    type: 'system',
    category: 'player',
    userId: uid,
    text: `${source.name || 'A group'} merged into ${target.name || 'a group'} at (${x},${y})`,
    timestamp: now,
    location: { x, y }
  });
  // Any player character travelling with the source group now rides with the
  // target — keep its life pointer in sync.
  for (const [unitKey, unit] of Object.entries(source.units || {})) {
    if (unit.type === 'player') {
      ops.player(uid, worldId, 'inGroup', targetGroupId);
      await patchLife(db, unitKey, { inGroup: targetGroupId }).catch(() => {});
    }
  }

  await ops.flush(db);

  return { success: true, groupId: targetGroupId };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export default mergeGroups;
