/**
 * Join world action — registers a player in a world
 */

import { incrementPlayerCount, getPlayerWorldData, setPlayerWorldData } from '../../db/players.js';
import { foundHouseForPlayer, requestToJoinHouse } from '../../db/houses.js';

export async function joinWorld({ uid, data, db }) {
  const { worldId, race, displayName, houseName, houseId, spawnPosition } = data;

  if (!worldId) throw err(400, 'worldId is required');
  if (!race)    throw err(400, 'race is required');
  if (displayName && (displayName.length < 2 || displayName.length > 20)) {
    throw err(400, 'displayName must be between 2 and 20 characters');
  }
  // A house is OPTIONAL. A player may join with none, found a new one
  // (houseName, immediate), or request to join an existing one (houseId,
  // pending the founder's approval).
  if (houseName && houseName.trim().length > 24) {
    throw err(400, 'houseName must be 24 characters or fewer');
  }

  const world = await db.collection('worlds').findOne({ _id: worldId }, { projection: { _id: 1 } });
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

  // Resolve the requested house relationship. Founding is immediate; joining an
  // existing house only records a request (see requestToJoinHouse). With neither
  // provided, the player simply has no house.
  const name = (displayName || '').trim();
  let house = null;
  let requested = false;
  if (houseName && houseName.trim()) {
    house = await foundHouseForPlayer(db, worldId, uid, name, houseName.trim());
  } else if (houseId) {
    await requestToJoinHouse(db, worldId, uid, name, houseId);
    requested = true;
  }

  if (isNewPlayer) await incrementPlayerCount(db, worldId);

  return {
    success: true, worldId, coordinates, isNewPlayer,
    houseId:   house ? house._id.toString() : null,
    houseName: house ? house.name : null,
    requestedHouseId: requested ? houseId : null,
  };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export { joinWorld as default };
