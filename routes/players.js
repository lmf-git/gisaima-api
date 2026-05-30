import { apiError } from '../core/auth.js';
import { getPlayerJoinedWorlds, getPlayerWorldData } from '../db/players.js';
import { getPlayerHouse } from '../db/houses.js';

export async function getPlayerWorlds(db, auth, userId) {
  if (auth.uid !== userId) throw apiError(403, 'forbidden');
  return getPlayerJoinedWorlds(db, userId);
}

export async function getPlayerWorldState(db, auth, userId, worldId) {
  if (auth.uid !== userId) throw apiError(403, 'forbidden');
  const data = await getPlayerWorldData(db, userId, worldId);
  if (!data) throw apiError(404, 'player world data not found');

  // Resolve the player's house from the house entity (the source of truth).
  const house = await getPlayerHouse(db, worldId, userId);
  return {
    ...data,
    houseId:   house ? house._id.toString() : null,
    houseName: house ? house.name : null,
  };
}
