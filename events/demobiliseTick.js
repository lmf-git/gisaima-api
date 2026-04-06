/**
 * Demobilization tick processing for Gisaima
 */

import { merge } from 'gisaima-shared/economy/items.js';

export function processDemobilization(worldId, ops, group, chunkKey, tileKey, groupId, tile, now) {
  if (group.status !== 'demobilising') return false;

  const groupName      = group.name || 'Unnamed group';
  const structureName  = tile.structure?.name || 'structure';

  if (!tile.structure) {
    console.warn(`No structure found for demobilizing group ${groupId}`);
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.status`, 'idle');
    return false;
  }

  const storageDestination = group.storageDestination || 'shared';

  if (group.items && Object.keys(group.items).length > 0) {
    const groupItems = group.items;

    if (storageDestination === 'personal' && group.owner) {
      const existingBankItems = tile.structure.banks?.[group.owner] || {};
      ops.chunk(worldId, chunkKey, `${tileKey}.structure.banks.${group.owner}`, merge(existingBankItems, groupItems));
    } else {
      if (!tile.structure.items) {
        ops.chunk(worldId, chunkKey, `${tileKey}.structure.items`, Array.isArray(groupItems) ? merge({}, groupItems) : { ...groupItems });
      } else {
        ops.chunk(worldId, chunkKey, `${tileKey}.structure.items`, merge(tile.structure.items, groupItems));
      }
    }
  }

  if (group.units) {
    const isMonsterGroup = group.type === 'monster';

    if (isMonsterGroup) {
      const unitValues   = Array.isArray(group.units) ? group.units : Object.values(group.units);
      const monsterCount = unitValues.length;
      const currentCount = tile.structure.monsterCount || 0;
      ops.chunk(worldId, chunkKey, `${tileKey}.structure.monsterCount`, currentCount + monsterCount);

      const monsterTypes = {};
      unitValues.forEach(u => { const t = u.type || 'unknown'; monsterTypes[t] = (monsterTypes[t] || 0) + 1; });
      if (!tile.structure.monsterTypes) {
        ops.chunk(worldId, chunkKey, `${tileKey}.structure.monsterTypes`, monsterTypes);
      } else {
        const updated = { ...tile.structure.monsterTypes };
        Object.entries(monsterTypes).forEach(([t, c]) => { updated[t] = (updated[t] || 0) + c; });
        ops.chunk(worldId, chunkKey, `${tileKey}.structure.monsterTypes`, updated);
      }
      ops.chunk(worldId, chunkKey, `${tileKey}.structure.lastReinforced`, now);
    } else {
      const unitValues     = Array.isArray(group.units) ? group.units : Object.values(group.units);
      const playerUnits    = unitValues.filter(u => u.type === 'player');
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
          ops.chunk(worldId, pChunkKey, `${pTileKey}.players.${pu.id}`, {
            displayName: pu.displayName || pu.name || `Player ${pu.id}`,
            id: pu.id,
            race: pu.race || 'human'
          });
          ops.player(pu.id, worldId, 'lastLocation', { x: loc.x, y: loc.y, timestamp: now });
          ops.player(pu.id, worldId, 'inGroup', null);
        }
      }

      if (nonPlayerUnits.length > 0) {
        const ownerId     = group.owner || 'shared';
        let existingUnits = [];
        if (tile.structure?.units?.[ownerId]) {
          existingUnits = Array.isArray(tile.structure.units[ownerId])
            ? tile.structure.units[ownerId]
            : Object.values(tile.structure.units[ownerId]);
        }
        ops.chunk(worldId, chunkKey, `${tileKey}.structure.units.${ownerId}`, [...existingUnits, ...nonPlayerUnits]);
      }
    }
  }

  const [x, y] = tileKey.split(',').map(Number);
  ops.chat(worldId, {
    text: `${groupName} has been demobilized into ${structureName} at (${x}, ${y})`,
    type: 'event',
    timestamp: now,
    location: { x, y }
  });

  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}`, null);
  return true;
}
