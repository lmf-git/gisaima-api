import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { TerrainGenerator } from 'gisaima-shared/map/noise.js';
import { Units } from 'gisaima-shared/units/units.js';
import { Ops } from '../../lib/ops.js';
import { canUse } from '../../structures/access.js';
import { grantAchievement } from '../../lib/achievements.js';

// Cache one terrain generator per world for the lifetime of the process.
const _terrainByWorld = new Map();
async function _terrainFor(db, worldId) {
  if (_terrainByWorld.has(worldId)) return _terrainByWorld.get(worldId);
  const w = await db.collection('worlds').findOne({ _id: worldId }, { projection: { 'info.seed': 1 } });
  const gen = new TerrainGenerator(w?.info?.seed ?? 1, 4_000);
  _terrainByWorld.set(worldId, gen);
  return gen;
}

// Boats are water-motion units; they can only be put to sea from a structure
// that sits on or borders water (the same gate the build/harbour logic uses).
function isBoatUnit(unitDef) {
  return unitDef?.type === 'boat'
    || unitDef?.type === 'ship'
    || (Array.isArray(unitDef?.motion) && unitDef.motion.includes('water'));
}

async function hasWaterAccess(db, worldId, x, y) {
  const terrain = await _terrainFor(db, worldId);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (terrain.getTerrainData(x + dx, y + dy)?.water) return true;
    }
  }
  return false;
}

export async function recruitUnits({ uid, data, db }) {
  const { structureId, x, y, worldId, unitType, quantity, cost } = data;

  if (!structureId || x === undefined || y === undefined || !worldId || !unitType || !quantity) {
    throw err(400, 'Missing required parameters');
  }
  if (quantity <= 0 || quantity > 100) throw err(400, 'Quantity must be between 1 and 100');

  const unitDef = Units.getUnit(unitType, 'player');
  if (!unitDef) throw err(400, `Invalid unit type: ${unitType}`);

  const chunkKey = getChunkKey(x, y);
  const tileKey  = `${x},${y}`;

  const chunkDoc  = await db.collection('chunks').findOne({ worldId, chunkKey });
  const structure = chunkDoc?.tiles?.[tileKey]?.structure;

  if (!structure) throw err(404, 'Structure not found at this location');
  if (structure.type === 'ruins' || structure.status === 'building') {
    throw err(409, 'This structure cannot recruit units');
  }
  if (unitDef.race && structure.race !== unitDef.race) {
    throw err(409, `This structure cannot recruit ${unitDef.race} units`);
  }

  // Authoritative requirement enforcement (structure level/type, building
  // level, research). The client only uses these to grey out options; without
  // this a crafted request could recruit elite units at a basic shelter.
  const reqCheck = Units.checkRecruitRequirements(structure, unitType);
  if (!reqCheck.ok) throw err(409, reqCheck.reason);

  // Boats need water access — the structure must sit on or beside water. Without
  // this a landlocked structure (no harbour, no shoreline) could raise a fleet
  // that has nowhere to launch.
  if (isBoatUnit(unitDef) && !(await hasWaterAccess(db, worldId, x, y))) {
    throw err(409, 'Boats can only be recruited at a structure on or beside water.');
  }

  const isOwned = structure.owner === uid;
  const allowed = await canUse({ db, worldId, structure, uid, action: 'recruit' });
  if (!allowed) throw err(403, 'You do not have permission to recruit at this structure');

  const maxQueue   = structure.capacity || 10;
  const queueItems = Object.values(structure.recruitmentQueue || {}).filter(i => i && typeof i === 'object');
  if (queueItems.length >= maxQueue) throw err(409, 'Recruitment queue is full');

  const bankItems   = _normalizeItems(structure.banks?.[uid] || {});
  const sharedItems = isOwned ? _normalizeItems(structure.items || {}) : {};
  const combined    = { ...bankItems };
  if (isOwned) for (const [k, v] of Object.entries(sharedItems)) combined[k] = (combined[k] || 0) + v;

  const insufficient = [];
  for (const [rk, needed] of Object.entries(cost || {})) {
    const have = combined[rk.toUpperCase()] || 0;
    if (have < needed) insufficient.push(`${rk} (need ${needed}, have ${have})`);
  }
  if (insufficient.length) throw err(409, `Insufficient resources: ${insufficient.join(', ')}`);

  const worldDoc   = await db.collection('worlds').findOne({ _id: worldId }, { projection: { info: 1 } });
  const worldSpeed = worldDoc?.info?.speed || 1;
  const ticksPerUnit = unitDef.timePerUnit || 1;
  const totalTicks   = ticksPerUnit * quantity;
  const adjTicks     = totalTicks / worldSpeed;
  const now          = Date.now();
  const completesAt  = now + adjTicks * 60000;

  const recruitmentId = `recruitment_${now}_${Math.floor(Math.random() * 1000)}`;

  const recruitmentData = {
    id: recruitmentId, unitId: unitType, unitName: unitDef.name,
    type: unitDef.type, race: unitDef.race || structure.race, icon: unitDef.icon,
    quantity, startedAt: now, completesAt,
    ticksRequired: Math.ceil(adjTicks), owner: uid, cost: cost || {}
  };

  const updatedBank   = { ...bankItems };
  const updatedShared = { ...sharedItems };
  for (const [rk, needed] of Object.entries(cost || {})) {
    const key = rk.toUpperCase();
    let left  = needed;
    if (updatedBank[key]) {
      const take = Math.min(updatedBank[key], left);
      updatedBank[key] -= take; left -= take;
      if (updatedBank[key] <= 0) delete updatedBank[key];
    }
    if (left > 0 && updatedShared[key]) {
      const take = Math.min(updatedShared[key], left);
      updatedShared[key] -= take;
      if (updatedShared[key] <= 0) delete updatedShared[key];
    }
  }

  const ops = new Ops();
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.recruitmentQueue.${recruitmentId}`, recruitmentData);
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.banks.${uid}`,                      updatedBank);
  ops.chat(worldId, {
    text: `${quantity} ${unitDef.name} units being recruited at (${x}, ${y})`,
    type: 'event', category: 'player', userId: uid, timestamp: now, location: { x, y }
  });
  if (isOwned) ops.chunk(worldId, chunkKey, `${tileKey}.structure.items`, updatedShared);

  await ops.flush(db);

  await grantAchievement(db, uid, worldId, 'first_recruit');

  return { success: true, recruitmentId, completesAt };
}

function _normalizeItems(items) {
  if (!items || typeof items !== 'object') return {};
  if (Array.isArray(items)) {
    const out = {};
    for (const item of items) {
      if (!item) continue;
      const k = (item.id || item.name || '').toUpperCase();
      if (k) out[k] = (out[k] || 0) + (item.quantity || 0);
    }
    return out;
  }
  const out = {};
  for (const [k, v] of Object.entries(items)) out[k.toUpperCase()] = v;
  return out;
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export default recruitUnits;
