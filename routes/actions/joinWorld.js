/**
 * Join world action — registers a player in a world
 */

import { incrementPlayerCount, getPlayerWorldData, setPlayerWorldData } from '../../db/players.js';
import { foundHouseForPlayer, joinHouseForPlayer } from '../../db/houses.js';

export async function joinWorld({ uid, data, db }) {
  const { worldId, race, displayName, houseName, houseId, spawnPosition } = data;

  if (!worldId) throw err(400, 'worldId is required');
  if (!race)    throw err(400, 'race is required');
  if (displayName && (displayName.length < 2 || displayName.length > 20)) {
    throw err(400, 'displayName must be between 2 and 20 characters');
  }
  // Every player must belong to a house: either join an existing one (houseId)
  // or found a new one (houseName).
  if (!houseId && !(houseName && houseName.trim())) {
    throw err(400, 'a house is required: provide houseId or houseName');
  }
  if (houseName && houseName.trim().length > 24) {
    throw err(400, 'houseName must be 24 characters or fewer');
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

  // Place the player in a house. The house's members[] is the source of truth;
  // the player's house is resolved from it on read, not stored on the player.
  const name = (displayName || '').trim();
  const house = houseId
    ? await joinHouseForPlayer(db, worldId, uid, name, houseId)
    : await foundHouseForPlayer(db, worldId, uid, name, houseName.trim());

  if (isNewPlayer) await incrementPlayerCount(db, worldId);

  return { success: true, worldId, coordinates, isNewPlayer, houseId: house._id.toString(), houseName: house.name };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export { joinWorld as default };
