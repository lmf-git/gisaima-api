import {
  getWorldTribes, getPlayerTribe, createTribe,
  addMemberToTribe, removeMemberFromTribe, deleteTribe,
  getTribeById, getRankings,
} from '../db/tribes.js';

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export async function getTribes(db, auth, worldId) {
  const tribes = await getWorldTribes(db, worldId);
  return tribes.map(t => ({ ...t, _id: t._id.toString() }));
}

export async function postCreateTribe(db, auth, worldId, body) {
  const { name, tag, description } = body;
  if (!name?.trim()) throw err(400, 'Tribe name is required');
  if (!tag?.trim())  throw err(400, 'Tribe tag is required');

  const existing = await getPlayerTribe(db, worldId, auth.uid);
  if (existing) throw err(409, 'You are already in a tribe');

  const playerDoc = await db.collection('players').findOne({ _id: auth.uid });
  const displayName = playerDoc?.worlds?.[worldId]?.displayName || 'Unknown';

  const tribe = await createTribe(db, worldId, auth.uid, displayName, name.trim(), tag.trim(), description?.trim());
  return { success: true, tribe: { ...tribe, _id: tribe._id.toString() } };
}

export async function postJoinTribe(db, auth, worldId, tribeId) {
  const existing = await getPlayerTribe(db, worldId, auth.uid);
  if (existing) throw err(409, 'You are already in a tribe');

  const tribe = await getTribeById(db, tribeId);
  if (!tribe || tribe.worldId !== worldId) throw err(404, 'Tribe not found');

  const playerDoc = await db.collection('players').findOne({ _id: auth.uid });
  const displayName = playerDoc?.worlds?.[worldId]?.displayName || 'Unknown';

  await addMemberToTribe(db, tribeId, auth.uid, displayName);
  return { success: true };
}

export async function postLeaveTribe(db, auth, worldId) {
  const tribe = await getPlayerTribe(db, worldId, auth.uid);
  if (!tribe) throw err(404, 'You are not in a tribe');

  const tribeId = tribe._id.toString();

  if (tribe.leaderId === auth.uid) {
    // If leader is leaving and there are other members, transfer leadership
    const others = tribe.members.filter(m => m.uid !== auth.uid);
    if (others.length > 0) {
      await db.collection('tribes').updateOne(
        { _id: tribe._id },
        { $set: { leaderId: others[0].uid, leaderName: others[0].displayName }, $pull: { members: { uid: auth.uid } } }
      );
    } else {
      await deleteTribe(db, tribeId);
    }
  } else {
    await removeMemberFromTribe(db, tribeId, auth.uid);
  }

  return { success: true };
}

export async function getWorldRankings(db, worldId) {
  return getRankings(db, worldId);
}
