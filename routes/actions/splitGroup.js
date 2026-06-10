/**
 * Split a group — carve selected units out of one of your idle groups into a
 * new group on the same tile (notes: "armies may be split and given separate
 * orders"). The player character stays with the source group; both halves
 * must end up with at least one unit. Motion capabilities are recomputed for
 * both halves from their remaining units.
 */
import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import UNITS from 'gisaima-shared/definitions/UNITS.js';
import { Ops } from '../../lib/ops.js';

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

export async function splitGroup({ uid, data, db }) {
  const { worldId, x, y, groupId, unitIds, name } = data || {};
  if (!worldId || !groupId || x === undefined || y === undefined) {
    throw err(400, 'worldId, groupId, x, y required');
  }
  if (!Array.isArray(unitIds) || unitIds.length === 0) {
    throw err(400, 'unitIds must be a non-empty array');
  }

  const chunkKey = getChunkKey(x, y);
  const tileKey  = `${x},${y}`;
  const chunkDoc = await db.collection('chunks').findOne({ worldId, chunkKey });
  const group    = chunkDoc?.tiles?.[tileKey]?.groups?.[groupId];

  if (!group)                  throw err(404, 'Group not found at specified location');
  if (group.owner !== uid)     throw err(403, 'You can only split your own groups');
  if (group.status !== 'idle') throw err(409, `Group cannot be split while ${group.status}`);

  const wanted = new Set(unitIds);
  const movedUnits = {};
  const keptUnits  = {};
  for (const [unitKey, unit] of Object.entries(group.units || {})) {
    if (wanted.has(unit.id) && unit.type !== 'player') movedUnits[unitKey] = unit;
    else keptUnits[unitKey] = unit;
  }

  if (!Object.keys(movedUnits).length) throw err(400, 'No splittable units matched (player characters stay with the group)');
  if (!Object.keys(keptUnits).length)  throw err(409, 'The original group must keep at least one unit');

  const now        = Date.now();
  const newGroupId = `group_${now}_${Math.floor(Math.random() * 10000)}`;
  const newMotion  = motionFor(movedUnits);
  const keptMotion = motionFor(keptUnits);

  const newGroup = {
    id: newGroupId,
    name: (name || '').trim() || `${group.name || 'Group'} (detached)`,
    owner: uid,
    ownerName: group.ownerName,
    status: 'idle',
    x, y,
    race: group.race || null,
    units: movedUnits,
    items: {},
    fleeAtLosses: group.fleeAtLosses ?? 40,
    joinBattlesInProgress: group.joinBattlesInProgress !== false,
    ...newMotion,
  };

  const ops = new Ops();
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.units`, keptUnits);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.motion`, keptMotion.motion);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.boatCapacity`, keptMotion.boatCapacity || null);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.transportedUnits`, keptMotion.transportedUnits || null);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${newGroupId}`, newGroup);
  ops.chat(worldId, {
    type: 'system',
    category: 'player',
    userId: uid,
    text: `${group.name || 'A group'} split off ${Object.keys(movedUnits).length} unit(s) as ${newGroup.name} at (${x},${y})`,
    timestamp: now,
    location: { x, y }
  });
  await ops.flush(db);

  return { success: true, groupId: newGroupId };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export default splitGroup;
