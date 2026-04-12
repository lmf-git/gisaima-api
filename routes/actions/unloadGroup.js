/**
 * Unload a passenger group from a boat onto the current tile
 */

import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { TerrainGenerator } from 'gisaima-shared/map/noise.js';
import { Ops } from '../../lib/ops.js';

export async function unloadGroup({ uid, data, db }) {
  const { worldId, boatGroupId, passengerGroupId, tileX, tileY } = data;

  if (!worldId || !boatGroupId || !passengerGroupId || tileX === undefined || tileY === undefined) {
    throw err(400, 'Missing required parameters');
  }

  const chunkKey = getChunkKey(tileX, tileY);
  const tileKey  = `${tileX},${tileY}`;

  const chunkDoc = await db.collection('chunks').findOne({ worldId, chunkKey });
  const tile     = chunkDoc?.tiles?.[tileKey];
  if (!tile?.groups?.[boatGroupId]) throw err(404, 'Boat group not found at this tile');

  const boatGroup = tile.groups[boatGroupId];

  if (boatGroup.owner !== uid) throw err(403, 'You do not own the boat group');
  if (boatGroup.status !== 'idle') {
    throw err(409, `Cannot unload while boat is in ${boatGroup.status} status`);
  }
  if (!boatGroup.passengers?.[passengerGroupId]) {
    throw err(404, 'Passenger group not found on this boat');
  }

  // Prevent unloading onto water tiles
  const worldDoc = await db.collection('worlds').findOne({ _id: worldId });
  const worldSeed = worldDoc?.info?.seed;
  if (worldSeed !== undefined && worldSeed !== null) {
    const generator = new TerrainGenerator(worldSeed, 1);
    const terrainData = generator.getTerrainData(tileX, tileY);
    if (terrainData?.biome?.water) {
      throw err(400, 'Cannot disembark onto a water tile — move to land first');
    }
  }

  const passengerGroup = boatGroup.passengers[passengerGroupId];
  const updatedGroups  = JSON.parse(JSON.stringify(tile.groups));

  // Remove passenger from boat's passengers
  delete updatedGroups[boatGroupId].passengers[passengerGroupId];

  // Place passenger group back on tile as idle
  updatedGroups[passengerGroupId] = {
    ...passengerGroup,
    status: 'idle',
    x: tileX,
    y: tileY
  };

  const ops = new Ops();
  ops.chunk(worldId, chunkKey, `${tileKey}.groups`, updatedGroups);
  ops.chat(worldId, {
    type: 'system',
    category: 'player',
    userId: uid,
    text: `${passengerGroup.name || 'A group'} has disembarked from ${boatGroup.name || 'a boat'} at (${tileX},${tileY})`,
    timestamp: Date.now(),
    location: { x: tileX, y: tileY }
  });

  await ops.flush(db);
  return { success: true };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export default unloadGroup;
