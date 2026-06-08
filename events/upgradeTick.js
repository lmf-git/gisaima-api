/**
 * Upgrade tick processing for Gisaima
 * Applies completed structure and building upgrades
 */

import { BUILDINGS } from 'gisaima-shared';
import { STRUCTURES, promotedStructureType } from 'gisaima-shared/definitions/STRUCTURES.js';
import { Ops } from '../lib/ops.js';

export const upgradeTickProcessor = processUpgrades;

export async function processUpgrades(worldId, worldData, db) {
  try {
    const now          = Date.now();
    const upgradesData = worldData?.upgrades;
    if (!upgradesData) return { processed: 0 };

    const pending = Object.entries(upgradesData)
      .filter(([, u]) => u.status === 'pending' && u.completesAt <= now && !u.processed)
      .map(([id, u]) => ({ ...u, id }));

    console.log(`[upgradeTick] ${pending.length} completed upgrades for ${worldId}`);

    let completed = 0, failed = 0;

    for (const upgrade of pending) {
      try {
        const result = await applyUpgrade(worldId, upgrade, worldData, db, now);
        if (result.success) completed++;
        else failed++;
      } catch (err) {
        console.error(`Error processing upgrade ${upgrade.id}:`, err);
        failed++;
        const ops = new Ops();
        ops.world(worldId, `upgrades.${upgrade.id}.processed`,  true);
        ops.world(worldId, `upgrades.${upgrade.id}.failed`,     true);
        ops.world(worldId, `upgrades.${upgrade.id}.error`,      err.message);
        ops.world(worldId, `upgrades.${upgrade.id}.processedAt`, now);
        await ops.flush(db);
      }
    }

    return { processed: completed, failed, total: pending.length };
  } catch (err) {
    console.error('Error processing upgrades:', err);
    return { success: false, error: err.message };
  }
}

async function applyUpgrade(worldId, upgrade, worldData, db, now) {
  const { chunkKey, tileKey, fromLevel, toLevel } = upgrade;

  if (upgrade.type === 'building' && upgrade.buildingId) {
    return applyBuildingUpgrade(worldId, upgrade, worldData, db, now);
  }

  const structure = worldData?.chunks?.[chunkKey]?.[tileKey]?.structure;
  if (!structure) throw new Error('Structure not found in provided world data');
  if ((structure.level || 1) !== fromLevel) throw new Error('Structure level mismatch');

  // Tiered promotion: a base on the defensive ladder changes type at level
  // thresholds (shelter → fortress → stronghold → citadel) rather than merely
  // gaining a level. The new type carries its own name/bonuses/sight/capacity.
  const newType = promotedStructureType(structure.type, toLevel);
  const tierDef = newType ? STRUCTURES[newType] : null;

  const updatedStructure = {
    ...structure,
    ...(tierDef ? {
      type: newType,
      // Keep a custom/player name if one was set; otherwise adopt the tier name.
      name: (structure.name && structure.name !== STRUCTURES[structure.type]?.name)
        ? structure.name : tierDef.name,
      bonuses: { ...(structure.bonuses || {}), ...(tierDef.bonuses || {}) },
      ...(tierDef.sightRange ? { sightRange: tierDef.sightRange } : {})
    } : {}),
    level: toLevel,
    upgradeInProgress: false,
    upgradeId: null,
    upgradeCompletesAt: null,
    lastUpgraded: now,
    features: dedupeFeatures([
      ...(structure.features || []),
      ...(tierDef ? (tierDef.features || []) : []),
      ...getNewFeaturesForLevel(newType || structure.type, toLevel)
    ]),
    // On promotion adopt the tier's larger capacity; otherwise grow the existing.
    ...(tierDef?.capacity
      ? { capacity: Math.max(tierDef.capacity, Math.floor((structure.capacity || 0) * 1.2)) }
      : (structure.capacity ? { capacity: Math.floor(structure.capacity * 1.2) } : {}))
  };

  const [x, y] = tileKey.split(',').map(Number);
  const ops = new Ops();
  ops.chunk(worldId, chunkKey, `${tileKey}.structure`, updatedStructure);
  ops.world(worldId, `upgrades.${upgrade.id}.processed`,  true);
  ops.world(worldId, `upgrades.${upgrade.id}.failed`,     false);
  ops.world(worldId, `upgrades.${upgrade.id}.processedAt`, now);
  ops.world(worldId, `upgrades.${upgrade.id}.status`,     'completed');
  ops.chat(worldId, {
    location: { x, y },
    text: tierDef
      ? `A structure at (${x}, ${y}) has risen to a ${tierDef.name} (level ${toLevel})!`
      : `A structure at (${x}, ${y}) has been upgraded to level ${toLevel}!`,
    timestamp: now,
    type: 'system',
    category: 'player'
  });

  if (upgrade.startedBy) {
    ops.player(upgrade.startedBy, null, `notifications.upgrade_${now}`, {
      type: 'upgrade_complete', worldId, structureId: structure.id,
      structureName: structure.name, location: { x, y }, fromLevel, toLevel, timestamp: now
    });
  }

  await ops.flush(db);
  return { success: true, structure: updatedStructure };
}

async function applyBuildingUpgrade(worldId, upgrade, worldData, db, now) {
  const { chunkKey, tileKey, buildingId, fromLevel, toLevel } = upgrade;
  const building = worldData?.chunks?.[chunkKey]?.[tileKey]?.structure?.buildings?.[buildingId];
  if (!building) throw new Error('Building not found in provided world data');
  if ((building.level || 1) !== fromLevel) throw new Error('Building level mismatch');

  const newBenefits    = BUILDINGS.getNewBenefitsForLevel(building.type, toLevel);
  const updatedBuilding = {
    ...building,
    level: toLevel,
    upgradeInProgress: false,
    upgradeId: null,
    upgradeStartedAt: null,
    upgradeCompletesAt: null,
    lastUpgraded: now,
    benefits: [
      ...(building.benefits || []).filter(b => !newBenefits?.some(nb => nb.name === b.name)),
      ...(newBenefits || [])
    ]
  };

  const [x, y] = tileKey.split(',').map(Number);
  const ops = new Ops();
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.buildings.${buildingId}`, updatedBuilding);
  ops.world(worldId, `upgrades.${upgrade.id}.processed`,  true);
  ops.world(worldId, `upgrades.${upgrade.id}.failed`,     false);
  ops.world(worldId, `upgrades.${upgrade.id}.processedAt`, now);
  ops.world(worldId, `upgrades.${upgrade.id}.status`,     'completed');
  ops.chat(worldId, {
    location: { x, y },
    text: `A ${building.name || building.type} at (${x}, ${y}) has been upgraded to level ${toLevel}!`,
    timestamp: now,
    type: 'system',
    category: 'player'
  });

  if (upgrade.startedBy) {
    ops.player(upgrade.startedBy, null, `notifications.building_upgrade_${now}`, {
      type: 'building_upgrade_complete', worldId, structureId: upgrade.structureId,
      buildingId, buildingName: building.name || building.type, location: { x, y },
      fromLevel, toLevel, timestamp: now
    });
  }

  await ops.flush(db);
  return { success: true, building: updatedBuilding };
}

// Collapse features to one per name, keeping the last occurrence so a tier's
// definition wins over an older same-named feature.
function dedupeFeatures(features) {
  const byName = new Map();
  for (const f of features) {
    if (!f?.name) continue;
    byName.set(f.name, f);
  }
  return [...byName.values()];
}

function getNewFeaturesForLevel(type, level) {
  const f = [];
  if (level === 2) {
    if (['outpost','fortress'].includes(type))
      f.push({ name: 'Storage Expansion', description: 'Increased storage capacity for items', icon: '📦' });
    if (['stronghold','fortress','citadel'].includes(type))
      f.push({ name: 'Basic Workshop', description: 'Allows crafting of simple items', icon: '🔨' });
  }
  if (level === 3) {
    if (['stronghold','fortress','citadel'].includes(type))
      f.push({ name: 'Training Yard', description: 'Allows training advanced units', icon: '🛡️' });
    if (['watchtower','outpost'].includes(type))
      f.push({ name: 'Extended View', description: 'Increases visibility range', icon: '👁️' });
  }
  if (level === 4 && ['fortress','citadel','stronghold'].includes(type))
    f.push({ name: 'Advanced Forge', description: 'Craft powerful weapons and armor', icon: '⚒️' });
  if (level === 5) {
    f.push({ name: 'Mastery', description: 'This structure has reached its maximum potential', icon: '✨' });
    if (['fortress','citadel'].includes(type))
      f.push({ name: 'Legendary Workshop', description: 'Craft legendary items', icon: '🌟' });
  }
  return f;
}
