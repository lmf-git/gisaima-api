import { apiError } from '../core/auth.js';
import { getPlayerJoinedWorlds, getPlayerWorldData } from '../db/players.js';
import { getPlayerHouse, getPlayerPendingRequest } from '../db/houses.js';

export async function getPlayerWorlds(db, auth, userId) {
  if (auth.uid !== userId) throw apiError(403, 'forbidden');
  return getPlayerJoinedWorlds(db, userId);
}

export async function getPlayerWorldState(db, auth, userId, worldId) {
  if (auth.uid !== userId) throw apiError(403, 'forbidden');
  const data = await getPlayerWorldData(db, userId, worldId);
  if (!data) throw apiError(404, 'player world data not found');

  // Resolve the player's house from the house entity (the source of truth).
  // Membership is optional, so all of these may be null/empty.
  const house = await getPlayerHouse(db, worldId, userId);
  const isFounder = !!house && house.founderId === userId;

  // A player may have an outstanding request awaiting approval (they keep any
  // current house until a founder approves them, at which point they move).
  const pendingRequest = await getPlayerPendingRequest(db, worldId, userId);

  return {
    ...data,
    houseId:        house ? house._id.toString() : null,
    houseName:      house ? house.name : null,
    isHouseFounder: isFounder,
    // The founder sees who is knocking; everyone else gets an empty list.
    houseRequests:  isFounder ? (house.joinRequests || []).map(r => ({
      uid: r.uid, displayName: r.displayName, requestedAt: r.requestedAt,
    })) : [],
    pendingHouseRequest: pendingRequest, // { houseId, houseName } | null
  };
}
