import { ObjectId } from 'mongodb';

export async function getWorldTribes(db, worldId) {
  return db.collection('tribes').find({ worldId }).sort({ createdAt: 1 }).toArray();
}

export async function getTribeById(db, tribeId) {
  return db.collection('tribes').findOne({ _id: new ObjectId(tribeId) });
}

export async function createTribe(db, worldId, leaderId, leaderName, name, tag, description) {
  const doc = {
    worldId,
    name,
    tag: tag.toUpperCase().slice(0, 5),
    leaderId,
    leaderName,
    description: description || '',
    members: [{ uid: leaderId, displayName: leaderName, joinedAt: Date.now() }],
    createdAt: Date.now(),
  };
  const result = await db.collection('tribes').insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

export async function addMemberToTribe(db, tribeId, uid, displayName) {
  return db.collection('tribes').updateOne(
    { _id: new ObjectId(tribeId) },
    { $push: { members: { uid, displayName, joinedAt: Date.now() } } }
  );
}

export async function removeMemberFromTribe(db, tribeId, uid) {
  return db.collection('tribes').updateOne(
    { _id: new ObjectId(tribeId) },
    { $pull: { members: { uid } } }
  );
}

export async function deleteTribe(db, tribeId) {
  return db.collection('tribes').deleteOne({ _id: new ObjectId(tribeId) });
}

export async function getPlayerTribe(db, worldId, uid) {
  return db.collection('tribes').findOne({ worldId, 'members.uid': uid });
}

