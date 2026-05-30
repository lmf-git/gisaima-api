import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { BUILDINGS } from 'gisaima-shared';
import { ITEMS } from 'gisaima-shared/definitions/ITEMS.js';
import { Ops } from '../../lib/ops.js';
import { canUse } from '../../structures/access.js';

export async function startBuildingUpgrade({ uid, data, db }) {
  const { worldId, x, y, buildingId } = data;
  if (!worldId || x === undefined || y === undefined || !buildingId) {
    throw err(400, 'Missing required parameters');
  }

  const chunkKey  = getChunkKey(x, y);
  const tileKey   = `${x},${y}`;

  const chunkDoc  = await db.collection('chunks').findOne({ worldId, chunkKey });
  const structure = chunkDoc?.tiles?.[tileKey]?.structure;
  if (!structure)                        throw err(404, 'Structure not found');
  if (!structure.buildings?.[buildingId]) throw err(404, 'Building not found');

  const building = structure.buildings[buildingId];
  if (building.upgradeInProgress) throw err(409, 'Building is already being upgraded');

  const allowed = await canUse({ db, worldId, structure, uid, action: 'build' });
  if (!allowed) throw err(403, 'You do not have permission to upgrade this building');

  const currentLevel = building.level || 1;
  if (currentLevel >= 5) throw err(409, 'Building is already at maximum level');
  const nextLevel = currentLevel + 1;

  const playerDoc = await db.collection('players').findOne({ _id: uid });
  if (!playerDoc?.worlds?.[worldId]) throw err(404, 'Player data not found');
  const player = playerDoc.worlds[worldId];

  // Requirements are code-based (display names resolved from ITEMS). Support
  // legacy entries that only carry a name via normalizeKey().
  const requiredResources = BUILDINGS.getUpgradeRequirements(building.type, currentLevel)
    .map(r => ({ code: r.code || normalizeKey(r.name), quantity: r.quantity }))
    .map(r => ({ ...r, name: ITEMS[r.code]?.name || r.code }));

  // Available resources from the shared pool, supporting both the array shape
  // (legacy [{name,quantity}]) and the object shape ({ CODE: qty }).
  const isArr = Array.isArray(structure.items);
  const avail = {};
  if (isArr) {
    for (const it of structure.items) {
      const c = ITEMS[it.id] ? it.id : normalizeKey(it.name || it.id);
      if (c) avail[c] = (avail[c] || 0) + (it.quantity || 0);
    }
  } else if (structure.items && typeof structure.items === 'object') {
    for (const [k, v] of Object.entries(structure.items)) avail[k.toUpperCase()] = (avail[k.toUpperCase()] || 0) + (v || 0);
  }

  for (const res of requiredResources) {
    const have = avail[res.code] || 0;
    if (have < res.quantity) throw err(409, `Insufficient ${res.name}: need ${res.quantity}, have ${have}`);
  }

  const upgradeTimeMs = BUILDINGS.calculateUpgradeTime(building.type, currentLevel) * 1000;
  const now           = Date.now();
  const upgradeId     = `building_upgrade_${worldId}_${buildingId}_${now}`;

  const spend = {};
  for (const res of requiredResources) spend[res.code] = (spend[res.code] || 0) + res.quantity;

  let updatedItems;
  if (isArr) {
    updatedItems = structure.items.map(item => {
      const c = ITEMS[item.id] ? item.id : normalizeKey(item.name || item.id);
      const take = spend[c] || 0;
      if (!take) return item;
      spend[c] = 0;
      const remaining = (item.quantity || 0) - take;
      return remaining > 0 ? { ...item, quantity: remaining } : null;
    }).filter(Boolean);
  } else {
    updatedItems = { ...(structure.items || {}) };
    for (const [code, need] of Object.entries(spend)) {
      const key = Object.keys(updatedItems).find(k => k.toUpperCase() === code) || code;
      const remaining = (updatedItems[key] || 0) - need;
      if (remaining > 0) updatedItems[key] = remaining; else delete updatedItems[key];
    }
  }

  const upgradeData = {
    id: upgradeId, type: 'building', worldId, buildingId,
    buildingType: building.type, buildingName: building.name || building.type,
    structureId: structure.id, chunkKey, tileKey,
    fromLevel: currentLevel, toLevel: nextLevel,
    startedAt: now, completesAt: now + upgradeTimeMs,
    startedBy: uid, playerName: player.displayName,
    resources: requiredResources, status: 'pending', processed: false
  };

  const ops = new Ops();
  ops.world(worldId, `upgrades.${upgradeId}`, upgradeData);
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.buildings.${buildingId}.upgradeInProgress`,  true);
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.buildings.${buildingId}.upgradeId`,          upgradeId);
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.buildings.${buildingId}.upgradeStartedAt`,   now);
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.buildings.${buildingId}.upgradeCompletesAt`, now + upgradeTimeMs);
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.items`, updatedItems);
  ops.chat(worldId, {
    location: { x, y },
    text: `${player.displayName} started upgrading a ${building.name || building.type} from level ${currentLevel} to ${nextLevel}.`,
    timestamp: now, type: 'event', category: 'player', userId: uid
  });

  await ops.flush(db);
  return { success: true, upgradeId, buildingId, fromLevel: currentLevel, toLevel: nextLevel, completesAt: now + upgradeTimeMs };
}

function normalizeKey(name) {
  if (!name) return '';
  const k = Object.keys(ITEMS).find(k => ITEMS[k].name === name);
  return k || name.toUpperCase().replace(/ /g, '_');
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export default startBuildingUpgrade;
