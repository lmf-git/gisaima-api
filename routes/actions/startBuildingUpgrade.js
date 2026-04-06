import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { BUILDINGS } from 'gisaima-shared';
import { ITEMS } from 'gisaima-shared/definitions/ITEMS.js';
import { Ops } from '../../lib/ops.js';

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

  const isOwner = structure.owner === uid;
  const isSpawn = structure.type === 'spawn';
  if (!isOwner && !isSpawn) throw err(403, 'You do not have permission to upgrade this building');

  const currentLevel = building.level || 1;
  if (currentLevel >= 5) throw err(409, 'Building is already at maximum level');
  const nextLevel = currentLevel + 1;

  const playerDoc = await db.collection('players').findOne({ _id: uid });
  if (!playerDoc?.worlds?.[worldId]) throw err(404, 'Player data not found');
  const player = playerDoc.worlds[worldId];

  const requiredResources = BUILDINGS.getUpgradeRequirements(building.type, currentLevel);

  const structureItems = Array.isArray(structure.items) ? structure.items : [];
  for (const res of requiredResources) {
    const found = structureItems.find(i => i.name === res.name || normalizeKey(i.name) === normalizeKey(res.name));
    const have  = found?.quantity || 0;
    if (have < res.quantity) throw err(409, `Insufficient ${res.name}: need ${res.quantity}, have ${have}`);
  }

  const upgradeTimeMs = BUILDINGS.calculateUpgradeTime(building.type, currentLevel) * 1000;
  const now           = Date.now();
  const upgradeId     = `building_upgrade_${worldId}_${buildingId}_${now}`;

  const updatedItems = structureItems.map(item => {
    const res = requiredResources.find(r => r.name === item.name || normalizeKey(r.name) === normalizeKey(item.name));
    if (!res) return item;
    const remaining = item.quantity - res.quantity;
    return remaining > 0 ? { ...item, quantity: remaining } : null;
  }).filter(Boolean);

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
    timestamp: now, type: 'event'
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
