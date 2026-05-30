import { ObjectId } from 'mongodb';
import { patchPlayerWorldData } from './players.js';

// A "house" is a player faction within a single world. Membership is mandatory:
// every player in a world belongs to exactly one house. The player's world doc
// keeps a denormalised `houseId` + `houseName` for cheap reads (e.g. the HUD).

export async function getWorldHouses(db, worldId) {
  return db.collection('houses').find({ worldId }).sort({ createdAt: 1 }).toArray();
}

export async function getHouseById(db, houseId) {
  if (!ObjectId.isValid(houseId)) return null;
  return db.collection('houses').findOne({ _id: new ObjectId(houseId) });
}

export async function getPlayerHouse(db, worldId, uid) {
  return db.collection('houses').findOne({ worldId, 'members.uid': uid });
}

export async function deleteHouse(db, houseId) {
  return db.collection('houses').deleteOne({ _id: new ObjectId(houseId) });
}

/**
 * Remove a player from their current house (if any), without touching their
 * player doc. When the founder leaves, leadership transfers to the next member;
 * the house is deleted once its last member departs.
 */
export async function leaveCurrentHouse(db, worldId, uid) {
  const current = await getPlayerHouse(db, worldId, uid);
  if (!current) return;

  if (current.founderId === uid) {
    const others = (current.members || []).filter(m => m.uid !== uid);
    if (others.length > 0) {
      await db.collection('houses').updateOne(
        { _id: current._id },
        { $set: { founderId: others[0].uid, founderName: others[0].displayName }, $pull: { members: { uid } } }
      );
    } else {
      await deleteHouse(db, current._id.toString());
    }
  } else {
    await db.collection('houses').updateOne(
      { _id: current._id },
      { $pull: { members: { uid } } }
    );
  }
}

/** Found a new house and move the player into it. Returns the new house doc. */
export async function foundHouseForPlayer(db, worldId, uid, displayName, name) {
  await leaveCurrentHouse(db, worldId, uid);

  const doc = {
    worldId,
    name,
    founderId: uid,
    founderName: displayName,
    members: [{ uid, displayName, joinedAt: Date.now() }],
    createdAt: Date.now(),
  };
  const result = await db.collection('houses').insertOne(doc);
  const house = { ...doc, _id: result.insertedId };

  await patchPlayerWorldData(db, uid, worldId, { houseId: house._id.toString(), houseName: name });
  return house;
}

/** Join an existing house and move the player into it. Returns the house doc. */
export async function joinHouseForPlayer(db, worldId, uid, displayName, houseId) {
  const house = await getHouseById(db, houseId);
  if (!house || house.worldId !== worldId) {
    throw Object.assign(new Error('House not found'), { status: 404 });
  }

  // Already a member — nothing to move.
  if ((house.members || []).some(m => m.uid === uid)) {
    await patchPlayerWorldData(db, uid, worldId, { houseId: house._id.toString(), houseName: house.name });
    return house;
  }

  await leaveCurrentHouse(db, worldId, uid);
  await db.collection('houses').updateOne(
    { _id: house._id },
    { $push: { members: { uid, displayName, joinedAt: Date.now() } } }
  );

  await patchPlayerWorldData(db, uid, worldId, { houseId: house._id.toString(), houseName: house.name });
  return house;
}
