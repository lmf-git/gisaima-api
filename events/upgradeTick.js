/**
 * Upgrade tick processing for Gisaima
 * Applies completed structure and building upgrades
 */

import { BUILDINGS } from 'gisaima-shared';
import { applyUpdates } from '../db/adapter.js';

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
        await applyUpdates(db, {
          [`worlds/${worldId}/upgrades/${upgrade.id}/processed`]:  true,
          [`worlds/${worldId}/upgrades/${upgrade.id}/failed`]:     true,
          [`worlds/${worldId}/upgrades/${upgrade.id}/error`]:      err.message,
          [`worlds/${worldId}/upgrades/${upgrade.id}/processedAt`]: now
        });
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

  const updatedStructure = {
    ...structure,
    level: toLevel,
    upgradeInProgress: false,
    upgradeId: null,
    upgradeCompletesAt: null,
    lastUpgraded: now,
    features: [
      ...(structure.features || []),
      ...getNewFeaturesForLevel(structure.type, toLevel)
    ],
    ...(structure.capacity ? { capacity: Math.floor(structure.capacity * 1.2) } : {})
  };

  const [x, y] = tileKey.split(',').map(Number);
  const updates = {
    [`worlds/${worldId}/chunks/${chunkKey}/${tileKey}/structure`]: updatedStructure,
    [`worlds/${worldId}/upgrades/${upgrade.id}/processed`]:  true,
    [`worlds/${worldId}/upgrades/${upgrade.id}/failed`]:     false,
    [`worlds/${worldId}/upgrades/${upgrade.id}/processedAt`]: now,
    [`worlds/${worldId}/upgrades/${upgrade.id}/status`]:     'completed',
    [`worlds/${worldId}/chat/upgrade_complete_${upgrade.id}`]: {
      location: { x, y },
      text: `A structure at (${x}, ${y}) has been upgraded to level ${toLevel}!`,
      timestamp: now,
      type: 'system'
    }
  };

  if (upgrade.startedBy) {
    updates[`players/${upgrade.startedBy}/notifications/upgrade_${now}`] = {
      type: 'upgrade_complete', worldId, structureId: structure.id,
      structureName: structure.name, location: { x, y }, fromLevel, toLevel, timestamp: now
    };
  }

  await applyUpdates(db, updates);
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
  const updates = {
    [`worlds/${worldId}/chunks/${chunkKey}/${tileKey}/structure/buildings/${buildingId}`]: updatedBuilding,
    [`worlds/${worldId}/upgrades/${upgrade.id}/processed`]:  true,
    [`worlds/${worldId}/upgrades/${upgrade.id}/failed`]:     false,
    [`worlds/${worldId}/upgrades/${upgrade.id}/processedAt`]: now,
    [`worlds/${worldId}/upgrades/${upgrade.id}/status`]:     'completed',
    [`worlds/${worldId}/chat/building_upgrade_complete_${upgrade.id}`]: {
      location: { x, y },
      text: `A ${building.name || building.type} at (${x}, ${y}) has been upgraded to level ${toLevel}!`,
      timestamp: now,
      type: 'system'
    }
  };

  if (upgrade.startedBy) {
    updates[`players/${upgrade.startedBy}/notifications/building_upgrade_${now}`] = {
      type: 'building_upgrade_complete', worldId, structureId: upgrade.structureId,
      buildingId, buildingName: building.name || building.type, location: { x, y },
      fromLevel, toLevel, timestamp: now
    };
  }

  await applyUpdates(db, updates);
  return { success: true, building: updatedBuilding };
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
