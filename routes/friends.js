import {
  areFriends, listFriends, listRequests,
  sendRequest, acceptRequest, declineRequest, removeFriend,
} from '../db/friends.js';

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

/** Resolve display names for a list of uids in one query. */
async function nameMap(db, worldId, uids) {
  const ids = [...new Set(uids)].filter(Boolean);
  if (!ids.length) return {};
  const docs = await db.collection('players').find(
    { _id: { $in: ids } },
    { projection: { _id: 1, [`worlds.${worldId}.displayName`]: 1 } }
  ).toArray();
  const map = {};
  for (const d of docs) map[d._id] = d.worlds?.[worldId]?.displayName || 'Unknown';
  return map;
}

/** Search players in a world by display-name (case-insensitive substring). */
export async function searchPlayers(db, auth, worldId, q) {
  const term = (q || '').trim();
  if (term.length < 2) return { players: [] };
  const safe = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameField = `worlds.${worldId}.displayName`;
  const docs = await db.collection('players').find(
    { [`worlds.${worldId}`]: { $exists: true }, [nameField]: { $regex: safe, $options: 'i' } },
    { projection: { _id: 1, [nameField]: 1 }, limit: 20 }
  ).toArray();
  return {
    players: docs
      .filter(d => d._id !== auth.uid)
      .map(d => ({ uid: d._id, displayName: d.worlds?.[worldId]?.displayName || 'Unknown' })),
  };
}

export async function getFriends(db, auth, worldId) {
  const uids = await listFriends(db, worldId, auth.uid);
  const names = await nameMap(db, worldId, uids);
  return { friends: uids.map(uid => ({ uid, displayName: names[uid] || 'Unknown' })) };
}

export async function getFriendRequests(db, auth, worldId) {
  const { incoming, outgoing } = await listRequests(db, worldId, auth.uid);
  const names = await nameMap(db, worldId, [...incoming.map(r => r.from), ...outgoing.map(r => r.to)]);
  return {
    incoming: incoming.map(r => ({ ...r, displayName: names[r.from] || 'Unknown' })),
    outgoing: outgoing.map(r => ({ ...r, displayName: names[r.to] || 'Unknown' })),
  };
}

export async function postFriendRequest(db, auth, worldId, body) {
  const toUid = body?.toUid;
  if (!toUid) throw err(400, 'toUid required');
  if (toUid === auth.uid) throw err(400, 'cannot friend yourself');
  return sendRequest(db, worldId, auth.uid, toUid);
}

export async function postAcceptRequest(db, auth, worldId, fromUid) {
  if (!fromUid) throw err(400, 'fromUid required');
  return acceptRequest(db, worldId, fromUid, auth.uid);
}

export async function postDeclineRequest(db, auth, worldId, otherUid) {
  if (!otherUid) throw err(400, 'uid required');
  // Either party may clear the pending request (decline incoming / cancel outgoing).
  await declineRequest(db, worldId, otherUid, auth.uid);
  await declineRequest(db, worldId, auth.uid, otherUid);
  return { status: 'declined' };
}

export async function postRemoveFriend(db, auth, worldId, otherUid) {
  if (!otherUid) throw err(400, 'uid required');
  if (!(await areFriends(db, worldId, auth.uid, otherUid))) throw err(404, 'not friends');
  return removeFriend(db, worldId, auth.uid, otherUid);
}
