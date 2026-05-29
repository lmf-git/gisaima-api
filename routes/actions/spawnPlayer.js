/**
 * Spawn player action — places one of the player's characters on the map.
 *
 * A user may control several concurrent characters. The optional `lifeId`
 * picks which character to place; without it we ensure/bind a default living
 * character. The map entity is keyed by the character's lifeId.
 */

import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { getPlayerWorldData } from '../../db/players.js';
import { ensureBoundLife, getLife, markSpawned } from '../../db/lives.js';
import { makePlayerEntity } from '../../lib/identity.js';
import { invalidate as invalidateVisibility } from '../../lib/visibility.js';
import { Ops } from '../../lib/ops.js';

export async function spawnPlayer({ uid, data, db }) {
  const { worldId, spawnX, spawnY, lifeId } = data;

  if (!worldId)                throw err(400, 'worldId is required');
  if (typeof spawnX !== 'number' || typeof spawnY !== 'number') {
    throw err(400, 'Valid spawn coordinates (spawnX, spawnY) are required');
  }

  const playerData = await getPlayerWorldData(db, uid, worldId);
  if (!playerData) throw err(404, `Player is not a member of world ${worldId}`);

  // Resolve which character to place. An explicit lifeId spawns that specific
  // (active, not-yet-placed) child; otherwise bind/ensure a default life.
  let life;
  if (lifeId) {
    life = await getLife(db, worldId, uid, lifeId);
    if (!life)        throw err(404, 'character not found');
    if (life.died)    throw err(409, 'that character has died');
    if (life.alive)   throw err(409, 'that character is already on the map');
  } else {
    life = await ensureBoundLife(db, worldId, uid, {
      name: playerData.displayName || uid.substring(0, 8),
      race: playerData.race || 'human'
    });
  }

  const displayName = life.name || playerData.displayName || uid.substring(0, 8);
  const race        = life.race || playerData.race || 'human';
  const entityId    = String(life._id);
  const chunkKey    = getChunkKey(spawnX, spawnY);
  const tileKey     = `${spawnX},${spawnY}`;
  const now         = Date.now();
  const location    = { x: spawnX, y: spawnY, timestamp: now };

  const ops = new Ops();
  ops.chunk(worldId, chunkKey, `${tileKey}.players.${entityId}`,
    makePlayerEntity({ lifeId: entityId, uid, displayName, race }));
  await ops.flush(db);

  // Mark the character placed + make it the controlled one.
  await markSpawned(db, worldId, uid, entityId, { x: spawnX, y: spawnY });

  // New sight source — force the next chunk fetch to rebuild visibility so the
  // spawn surroundings (incl. structures only player-sight covers) show at once.
  invalidateVisibility(worldId);

  return { success: true, lifeId: entityId, location: { x: spawnX, y: spawnY }, timestamp: now };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export { spawnPlayer as default };
