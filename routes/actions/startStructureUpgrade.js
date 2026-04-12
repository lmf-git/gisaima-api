import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { ITEMS } from 'gisaima-shared/definitions/ITEMS.js';
import { Ops } from '../../lib/ops.js';

export async function startStructureUpgrade({ uid, data, db }) {
  const { worldId, x, y } = data;
  if (!worldId || x === undefined || y === undefined) throw err(400, 'Missing required parameters');

  const chunkKey = getChunkKey(x, y);
  const tileKey  = `${x},${y}`;

  const chunkDoc  = await db.collection('chunks').findOne({ worldId, chunkKey });
  const structure = chunkDoc?.tiles?.[tileKey]?.structure;
  if (!structure)                  throw err(404, 'Structure not found');
  if (structure.upgradeInProgress) throw err(409, 'Structure is already being upgraded');

  const isOwner = structure.owner === uid;
  const isSpawn = structure.type === 'spawn';
  if (!isOwner && !isSpawn) throw err(403, 'You do not have permission to upgrade this structure');

  const currentLevel = structure.level || 1;
  if (currentLevel >= 5) throw err(409, 'Structure is already at maximum level');
  const nextLevel = currentLevel + 1;

  const playerDoc = await db.collection('players').findOne({ _id: uid });
  if (!playerDoc?.worlds?.[worldId]) throw err(404, 'Player data not found');
  const player = playerDoc.worlds[worldId];

  const requiredResources = getUpgradeRequirements(structure.type, currentLevel);

  const bankItems   = structure.banks?.[uid] || {};
  const sharedItems = isOwner ? (structure.items || {}) : {};
  const available   = _mergeResources(bankItems, sharedItems);

  for (const res of requiredResources) {
    const key  = normalizeKey(res.name);
    const have = available[key] || 0;
    if (have < res.quantity) throw err(409, `Insufficient ${res.name}: need ${res.quantity}, have ${have}`);
  }

  const upgradeTimeMs = calculateUpgradeTime(structure.type, currentLevel) * 1000;
  const now           = Date.now();
  const upgradeId     = `structure_upgrade_${worldId}_${tileKey.replace(',', '_')}_${now}`;

  const upgradeData = {
    id: upgradeId, type: 'structure', worldId,
    structureId: structure.id, structureType: structure.type,
    structureName: structure.name || structure.type,
    chunkKey, tileKey,
    fromLevel: currentLevel, toLevel: nextLevel,
    startedAt: now, completesAt: now + upgradeTimeMs,
    startedBy: uid, playerName: player.displayName,
    resources: requiredResources, status: 'pending', processed: false
  };

  const { updatedBank, updatedShared } = _deductResources(
    bankItems, isOwner ? sharedItems : {}, requiredResources
  );

  const ops = new Ops();
  ops.world(worldId, `upgrades.${upgradeId}`, upgradeData);
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.upgradeInProgress`,  true);
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.upgradeId`,          upgradeId);
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.upgradeCompletesAt`, now + upgradeTimeMs);
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.banks.${uid}`,       updatedBank);
  ops.chat(worldId, {
    location: { x, y },
    text: `${player.displayName} started upgrading a ${structure.name || structure.type} from level ${currentLevel} to ${nextLevel}.`,
    timestamp: now, type: 'event', category: 'player', userId: uid
  });
  if (isOwner) ops.chunk(worldId, chunkKey, `${tileKey}.structure.items`, updatedShared);

  await ops.flush(db);
  return { success: true, upgradeId, fromLevel: currentLevel, toLevel: nextLevel, completesAt: now + upgradeTimeMs };
}

function normalizeKey(name) {
  if (!name) return '';
  const k = Object.keys(ITEMS).find(k => ITEMS[k].name === name);
  return k || name.toUpperCase().replace(/ /g, '_');
}

function _mergeResources(bank, shared) {
  const out = {};
  const add = obj => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (!item || item.type !== 'resource') continue;
        const k = normalizeKey(item.id || item.name);
        out[k] = (out[k] || 0) + (item.quantity || 0);
      }
    } else {
      for (const [k, v] of Object.entries(obj)) out[k.toUpperCase()] = (out[k.toUpperCase()] || 0) + (v || 0);
    }
  };
  add(bank); add(shared);
  return out;
}

function _deductResources(bank, shared, resources) {
  const remaining     = Object.fromEntries(resources.map(r => [normalizeKey(r.name), r.quantity]));
  const updatedBank   = typeof bank === 'object' && !Array.isArray(bank) ? { ...bank } : {};
  const updatedShared = typeof shared === 'object' && !Array.isArray(shared) ? { ...shared } : {};

  for (const [key, needed] of Object.entries(remaining)) {
    let left = needed;
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
  return { updatedBank, updatedShared };
}

function getUpgradeRequirements(structureType, currentLevel) {
  const m = currentLevel * 1.5;
  const resources = [
    { name: 'Wooden Sticks', quantity: Math.floor(10 * m) },
    { name: 'Stone Pieces',  quantity: Math.floor(8  * m) }
  ];
  if (['fortress','stronghold'].includes(structureType)) resources.push({ name: 'Iron Ore', quantity: Math.floor(5 * m) });
  if (structureType === 'watchtower') resources.push({ name: 'Rope', quantity: Math.floor(3 * m) });
  if (structureType === 'citadel') {
    resources.push({ name: 'Iron Ore', quantity: Math.floor(8 * m) });
    resources.push({ name: 'Gold Ore', quantity: Math.floor(3 * m) });
  }
  if (structureType === 'spawn') {
    resources.forEach(r => { r.quantity = Math.floor(r.quantity * 1.5); });
    resources.push({ name: 'Crystal Shard', quantity: currentLevel });
  }
  if (currentLevel >= 3) resources.push({ name: 'Crystal Shard', quantity: currentLevel - 2 });
  return resources;
}

function calculateUpgradeTime(structureType, currentLevel) {
  const base = 120;
  const lm = 1 + currentLevel * 0.5;
  const tm = { outpost: 0.8, fortress: 1.5, stronghold: 1.5, watchtower: 0.7, citadel: 2.0, spawn: 2.5 }[structureType] || 1.0;
  return Math.ceil(base * lm * tm);
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export default startStructureUpgrade;
