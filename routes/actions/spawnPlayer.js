/**
 * Spawn player action — places a player entity on the world map
 */

import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { getPlayerWorldData } from '../../db/players.js';
import { Ops } from '../../lib/ops.js';

export async function spawnPlayer({ uid, data, db }) {
  const { worldId, spawnX, spawnY } = data;

  if (!worldId)                throw err(400, 'worldId is required');
  if (typeof spawnX !== 'number' || typeof spawnY !== 'number') {
    throw err(400, 'Valid spawn coordinates (spawnX, spawnY) are required');
  }

  const playerData = await getPlayerWorldData(db, uid, worldId);
  if (!playerData) throw err(404, `Player is not a member of world ${worldId}`);

  const displayName = playerData.displayName || uid.substring(0, 8);
  const race        = playerData.race || 'human';
  const chunkKey    = getChunkKey(spawnX, spawnY);
  const tileKey     = `${spawnX},${spawnY}`;
  const now         = Date.now();

  const ops = new Ops();
  ops.chunk(worldId, chunkKey, `${tileKey}.players.${uid}`, { displayName, id: uid, race });
  ops.player(uid, worldId, 'alive',        true);
  ops.player(uid, worldId, 'lastLocation', { x: spawnX, y: spawnY, timestamp: now });

  await ops.flush(db);

  return { success: true, location: { x: spawnX, y: spawnY }, timestamp: now };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export { spawnPlayer as default };
