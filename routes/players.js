import { apiError } from '../core/auth.js';
import { getPlayerJoinedWorlds, getPlayerWorldData } from '../db/players.js';

export async function getPlayerWorlds(db, auth, userId) {
  if (auth.uid !== userId) throw apiError(403, 'forbidden');
  return getPlayerJoinedWorlds(db, userId);
}

export async function getPlayerWorldState(db, auth, userId, worldId) {
  if (auth.uid !== userId) throw apiError(403, 'forbidden');
  const data = await getPlayerWorldData(db, userId, worldId);
  if (!data) throw apiError(404, 'player world data not found');
  return data;
}
