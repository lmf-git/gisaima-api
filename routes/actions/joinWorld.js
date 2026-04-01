/**
 * Join world action — registers a player in a world
 */

import { incrementPlayerCount, getPlayerWorldData, setPlayerWorldData } from '../../db/players.js';

export async function joinWorld({ uid, data, db }) {
  const { worldId, race, displayName, spawnPosition } = data;

  if (!worldId) throw err(400, 'worldId is required');
  if (!race)    throw err(400, 'race is required');
  if (displayName && (displayName.length < 2 || displayName.length > 20)) {
    throw err(400, 'displayName must be between 2 and 20 characters');
  }

  const world = await db.collection('worlds').findOne({ _id: worldId });
  if (!world) throw err(404, 'world not found');

  const coordinates = (spawnPosition && typeof spawnPosition.x === 'number' && typeof spawnPosition.y === 'number')
    ? { x: spawnPosition.x, y: spawnPosition.y }
    : { x: 0, y: 0 };

  const isNewPlayer = !(await getPlayerWorldData(db, uid, worldId));

  await setPlayerWorldData(db, uid, worldId, {
    joined: Date.now(),
    race,
    alive: false,
    displayName: displayName || '',
    id: uid,
    lastLocation: { x: coordinates.x, y: coordinates.y, timestamp: Date.now() }
  });

  if (isNewPlayer) await incrementPlayerCount(db, worldId);

  return { success: true, worldId, coordinates, isNewPlayer };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export { joinWorld as default };
