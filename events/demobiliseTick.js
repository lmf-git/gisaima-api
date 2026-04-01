/**
 * Demobilization tick processing for Gisaima
 */

import { merge } from 'gisaima-shared/economy/items.js';

export function processDemobilization(worldId, updates, group, chunkKey, tileKey, groupId, tile, now) {
  if (group.status !== 'demobilising') return false;

  const groupPath   = `worlds/${worldId}/chunks/${chunkKey}/${tileKey}/groups/${groupId}`;
  const groupName   = group.name || 'Unnamed group';
  const structureName = tile.structure?.name || 'structure';

  if (!tile.structure) {
    console.warn(`No structure found for demobilizing group ${groupId}`);
    updates[`${groupPath}/status`] = 'idle';
    return false;
  }

  const storageDestination = group.storageDestination || 'shared';

  if (group.items && Object.keys(group.items).length > 0) {
    const groupItems = group.items;

    if (storageDestination === 'personal' && group.owner) {
      const bankPath = `worlds/${worldId}/chunks/${chunkKey}/${tileKey}/structure/banks/${group.owner}`;
      const existingBankItems = tile.structure.banks?.[group.owner] || {};
      updates[bankPath] = merge(existingBankItems, groupItems);
    } else {
      const structurePath = `worlds/${worldId}/chunks/${chunkKey}/${tileKey}/structure/items`;
      if (!tile.structure.items) {
        updates[structurePath] = Array.isArray(groupItems) ? merge({}, groupItems) : { ...groupItems };
      } else {
        updates[structurePath] = merge(tile.structure.items, groupItems);
      }
    }
  }

  if (group.units) {
    const isMonsterGroup = group.type === 'monster';

    if (isMonsterGroup) {
      const unitValues     = Array.isArray(group.units) ? group.units : Object.values(group.units);
      const monsterCount   = unitValues.length;
      const currentCount   = tile.structure.monsterCount || 0;
      updates[`worlds/${worldId}/chunks/${chunkKey}/${tileKey}/structure/monsterCount`] = currentCount + monsterCount;

      const monsterTypes = {};
      unitValues.forEach(u => { const t = u.type || 'unknown'; monsterTypes[t] = (monsterTypes[t] || 0) + 1; });
      if (!tile.structure.monsterTypes) {
        updates[`worlds/${worldId}/chunks/${chunkKey}/${tileKey}/structure/monsterTypes`] = monsterTypes;
      } else {
        const updated = { ...tile.structure.monsterTypes };
        Object.entries(monsterTypes).forEach(([t, c]) => { updated[t] = (updated[t] || 0) + c; });
        updates[`worlds/${worldId}/chunks/${chunkKey}/${tileKey}/structure/monsterTypes`] = updated;
      }
      updates[`worlds/${worldId}/chunks/${chunkKey}/${tileKey}/structure/lastReinforced`] = now;
    } else {
      const unitValues   = Array.isArray(group.units) ? group.units : Object.values(group.units);
      const playerUnits  = unitValues.filter(u => u.type === 'player');
      const nonPlayerUnits = unitValues.filter(u => u.type !== 'player');

      for (const pu of playerUnits) {
        if (pu.id) {
          let loc;
          if (group.demobilizationData?.exactLocation) {
            loc = group.demobilizationData.exactLocation;
          } else {
            loc = { x: parseInt(tileKey.split(',')[0]), y: parseInt(tileKey.split(',')[1]), chunkKey };
          }
          const pChunkKey = loc.chunkKey || chunkKey;
          const pTileKey  = `${loc.x},${loc.y}`;
          updates[`worlds/${worldId}/chunks/${pChunkKey}/${pTileKey}/players/${pu.id}`] = {
            displayName: pu.displayName || pu.name || `Player ${pu.id}`,
            id: pu.id,
            race: pu.race || 'human'
          };
          updates[`players/${pu.id}/worlds/${worldId}/lastLocation`] = { x: loc.x, y: loc.y, timestamp: now };
          updates[`players/${pu.id}/worlds/${worldId}/inGroup`]      = null;
        }
      }

      if (nonPlayerUnits.length > 0) {
        const ownerId     = group.owner || 'shared';
        const unitsPath   = `worlds/${worldId}/chunks/${chunkKey}/${tileKey}/structure/units/${ownerId}`;
        let existingUnits = [];
        if (tile.structure?.units?.[ownerId]) {
          existingUnits = Array.isArray(tile.structure.units[ownerId])
            ? tile.structure.units[ownerId]
            : Object.values(tile.structure.units[ownerId]);
        }
        updates[unitsPath] = [...existingUnits, ...nonPlayerUnits];
      }
    }
  }

  const chatId = `demob_complete_${now}_${groupId}`;
  updates[`worlds/${worldId}/chat/${chatId}`] = {
    text: `${groupName} has been demobilized into ${structureName} at (${tileKey.replace(',', ', ')})`,
    type: 'event',
    timestamp: now,
    location: {
      x: parseInt(tileKey.split(',')[0]),
      y: parseInt(tileKey.split(',')[1])
    }
  };

  updates[groupPath] = null;
  return true;
}
