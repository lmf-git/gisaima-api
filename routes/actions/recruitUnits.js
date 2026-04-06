import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { Units } from 'gisaima-shared/units/units.js';
import { Ops } from '../../lib/ops.js';

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

  const isOwned = structure.owner === uid;
  const isSpawn = structure.type === 'spawn';
  if (!isOwned && !isSpawn) throw err(403, 'You do not own this structure');

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

  const worldDoc   = await db.collection('worlds').findOne({ _id: worldId });
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
    type: 'event', timestamp: now, location: { x, y }
  });
  if (isOwned) ops.chunk(worldId, chunkKey, `${tileKey}.structure.items`, updatedShared);

  await ops.flush(db);

  const playerDoc = await db.collection('players').findOne({ _id: uid });
  if (!playerDoc?.worlds?.[worldId]?.achievements?.first_recruit) {
    await db.collection('players').updateOne(
      { _id: uid },
      { $set: { [`worlds.${worldId}.achievements.first_recruit`]: true, [`worlds.${worldId}.achievements.first_recruit_date`]: now } },
      { upsert: true }
    );
  }

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
