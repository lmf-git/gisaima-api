/**
 * Building tick processing for Gisaima
 */

import { STRUCTURES } from 'gisaima-shared/definitions/STRUCTURES.js';
import { getStarterBuildings } from '../structures/starterBuildings.js';

export async function processBuilding(worldId, ops, chunkKey, tileKey, tile, now) {
  if (!tile.structure || tile.structure.status !== 'building') return false;

  const structure = tile.structure;
  if (structure.battleId) return false;

  if (structure.builder && tile.groups?.[structure.builder]) {
    const bg = tile.groups[structure.builder];
    if (bg.status === 'fighting' || bg.battleId) return false;
  }

  const progress = (structure.buildProgress || 0) + 1;
  const total    = STRUCTURES[structure.type]?.buildTime || 1;

  if (progress >= total) {
    completeStructure(worldId, ops, chunkKey, tileKey, tile, now);
    return true;
  }

  ops.chunk(worldId, chunkKey, `${tileKey}.structure.buildProgress`, progress);
  return false;
}

function completeStructure(worldId, ops, chunkKey, tileKey, tile, now) {
  const structure = tile.structure;

  ops.chunk(worldId, chunkKey, `${tileKey}.structure.status`, null);
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.buildProgress`, null);

  // Seed a few low-level buildings so the finished structure's subdivided tile
  // isn't empty when centred on. Only for non-monster structures that don't
  // already carry buildings; walls have no subgrid.
  if (!structure.monster &&
      structure.type !== 'wall' &&
      (!structure.buildings || Object.keys(structure.buildings).length === 0)) {
    const buildings = getStarterBuildings({
      structureId: structure.id,
      race: structure.race || null,
      isSpawn: structure.type === 'spawn',
      subN: 3,
      iconRow: structure.subRow,
      iconCol: structure.subCol,
    });
    if (Object.keys(buildings).length) {
      ops.chunk(worldId, chunkKey, `${tileKey}.structure.buildings`, buildings);
    }
  }

  if (structure.builder && tile.groups?.[structure.builder]) {
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${structure.builder}.status`, 'idle');
  }

  const [x, y] = tileKey.split(',').map(Number);
  ops.chat(worldId, {
    text: `${structure.name} has been completed at (${x}, ${y})`,
    type: 'event',
    category: structure.monster === true ? 'monster' : 'player',
    timestamp: now,
    userId: structure.owner || 'system',
    userName: structure.ownerName || (structure.monster === true ? 'Monsters' : 'Unknown'),
    location: { x, y, timestamp: now }
  });
}
