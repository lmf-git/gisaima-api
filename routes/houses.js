import {
  getWorldHouses, foundHouseForPlayer, requestToJoinHouse,
  cancelJoinRequest, leaveCurrentHouse, approveJoinRequest, rejectJoinRequest,
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
    // Per-viewer flags so the picker can reflect state without extra calls.
    isMember:    (h.members || []).some(m => m.uid === auth.uid),
    requested:   (h.joinRequests || []).some(r => r.uid === auth.uid),
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

// Joining an existing house is a request, not an immediate join — the founder
// must approve it (see postApproveJoinRequest).
export async function postRequestJoinHouse(db, auth, worldId, houseId) {
  if (!houseId) throw err(400, 'houseId is required');

  const displayName = await resolveDisplayName(db, worldId, auth.uid);
  const house = await requestToJoinHouse(db, worldId, auth.uid, displayName, houseId);
  return { success: true, requested: true, house: { _id: house._id.toString(), name: house.name } };
}

export async function postCancelJoinRequest(db, auth, worldId, houseId) {
  if (!houseId) throw err(400, 'houseId is required');
  await cancelJoinRequest(db, worldId, auth.uid, houseId);
  return { success: true };
}

export async function postLeaveHouse(db, auth, worldId) {
  await leaveCurrentHouse(db, worldId, auth.uid);
  return { success: true };
}

export async function postApproveJoinRequest(db, auth, worldId, houseId, applicantUid) {
  if (!houseId || !applicantUid) throw err(400, 'houseId and uid are required');
  await approveJoinRequest(db, worldId, auth.uid, houseId, applicantUid);
  return { success: true };
}

export async function postRejectJoinRequest(db, auth, worldId, houseId, applicantUid) {
  if (!houseId || !applicantUid) throw err(400, 'houseId and uid are required');
  await rejectJoinRequest(db, worldId, auth.uid, houseId, applicantUid);
  return { success: true };
}
