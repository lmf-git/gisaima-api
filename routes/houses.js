import {
  getWorldHouses, foundHouseForPlayer, joinHouseForPlayer,
} from '../db/houses.js';

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

async function resolveDisplayName(db, worldId, uid) {
  const playerDoc = await db.collection('players').findOne({ _id: uid });
  return playerDoc?.worlds?.[worldId]?.displayName || '';
}

export async function getHouses(db, auth, worldId) {
  const houses = await getWorldHouses(db, worldId);
  return houses.map(h => ({
    _id:         h._id.toString(),
    name:        h.name,
    founderName: h.founderName,
    memberCount: (h.members || []).length,
    createdAt:   h.createdAt,
  }));
}

export async function postCreateHouse(db, auth, worldId, body) {
  const name = body?.name?.trim();
  if (!name) throw err(400, 'House name is required');
  if (name.length < 2 || name.length > 24) {
    throw err(400, 'House name must be between 2 and 24 characters');
  }

  const displayName = await resolveDisplayName(db, worldId, auth.uid);
  const house = await foundHouseForPlayer(db, worldId, auth.uid, displayName, name);
  return { success: true, house: { _id: house._id.toString(), name: house.name } };
}

export async function postJoinHouse(db, auth, worldId, houseId) {
  if (!houseId) throw err(400, 'houseId is required');

  const displayName = await resolveDisplayName(db, worldId, auth.uid);
  const house = await joinHouseForPlayer(db, worldId, auth.uid, displayName, houseId);
  return { success: true, house: { _id: house._id.toString(), name: house.name } };
}
