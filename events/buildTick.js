/**
 * Building tick processing for Gisaima
 */

import { STRUCTURES } from 'gisaima-shared/definitions/STRUCTURES.js';

export async function processBuilding(worldId, updates, chunkKey, tileKey, tile, now) {
  if (!tile.structure || tile.structure.status !== 'building') return false;

  const structure = tile.structure;
  if (structure.battleId) return false;

  if (structure.builder && tile.groups?.[structure.builder]) {
    const bg = tile.groups[structure.builder];
    if (bg.status === 'fighting' || bg.battleId) return false;
  }

  const progress = (structure.buildProgress || 0) + 1;
  const total    = STRUCTURES[structure.type]?.buildTime || 1;
  const structurePath = `worlds/${worldId}/chunks/${chunkKey}/${tileKey}/structure`;

  if (progress >= total) {
    completeStructure(worldId, updates, chunkKey, tileKey, tile, now);
    return true;
  }

  updates[`${structurePath}/buildProgress`] = progress;
  return false;
}

function completeStructure(worldId, updates, chunkKey, tileKey, tile, now) {
  const structure     = tile.structure;
  const structurePath = `worlds/${worldId}/chunks/${chunkKey}/${tileKey}/structure`;

  updates[`${structurePath}/status`]        = null;
  updates[`${structurePath}/buildProgress`] = null;

  if (structure.builder && tile.groups?.[structure.builder]) {
    updates[`worlds/${worldId}/chunks/${chunkKey}/${tileKey}/groups/${structure.builder}/status`] = 'idle';
  }

  const chatKey = `chat_${now}_${Math.floor(Math.random() * 1000)}`;
  updates[`worlds/${worldId}/chat/${chatKey}`] = {
    text: `${structure.name} has been completed at (${tileKey.replace(',', ', ')})`,
    type: 'event',
    timestamp: now,
    userId: structure.owner || 'system',
    userName: structure.ownerName || (structure.monster === true ? 'Monsters' : 'Unknown'),
    location: {
      x: parseInt(tileKey.split(',')[0]),
      y: parseInt(tileKey.split(',')[1]),
      timestamp: now
    }
  };
}
