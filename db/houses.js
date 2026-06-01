import { ObjectId } from 'mongodb';

// A "house" is a player faction within a single world. Membership is OPTIONAL —
// a player may belong to no house at all. The house's `members[]` is the single
// source of truth for membership; the player's id/name are resolved from it on
// read (see getPlayerWorldState), never stored back onto the player doc.
//
// Founding a house is immediate (you are its founder). Joining an EXISTING house
// is gated by approval: the applicant is added to the house's `joinRequests[]`
// and only the founder can approve them into `members[]`. This stops anyone from
// walking into a house uninvited.

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

/** The house, if any, the player has an outstanding (unapproved) join request to. */
export async function getPlayerPendingRequest(db, worldId, uid) {
  const house = await db.collection('houses').findOne({ worldId, 'joinRequests.uid': uid });
  if (!house) return null;
  return { houseId: house._id.toString(), houseName: house.name };
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
  await clearPlayerRequests(db, worldId, uid);

  const doc = {
    worldId,
    name,
    founderId: uid,
    founderName: displayName,
    members: [{ uid, displayName, joinedAt: Date.now() }],
    joinRequests: [],
    createdAt: Date.now(),
  };
  const result = await db.collection('houses').insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

/** Drop any outstanding join requests this player has made, across all houses. */
export async function clearPlayerRequests(db, worldId, uid) {
  await db.collection('houses').updateMany(
    { worldId, 'joinRequests.uid': uid },
    { $pull: { joinRequests: { uid } } }
  );
}

/**
 * Record a request to join an existing house. Does NOT grant membership — the
 * founder must approve. Returns the house doc.
 */
export async function requestToJoinHouse(db, worldId, uid, displayName, houseId) {
  const house = await getHouseById(db, houseId);
  if (!house || house.worldId !== worldId) {
    throw Object.assign(new Error('House not found'), { status: 404 });
  }
  if ((house.members || []).some(m => m.uid === uid)) {
    throw Object.assign(new Error('You are already a member of this house'), { status: 409 });
  }
  if ((house.joinRequests || []).some(r => r.uid === uid)) return house; // idempotent

  await db.collection('houses').updateOne(
    { _id: house._id },
    { $push: { joinRequests: { uid, displayName, requestedAt: Date.now() } } }
  );
  return house;
}

/** Withdraw the player's own pending request to a house. */
export async function cancelJoinRequest(db, worldId, uid, houseId) {
  const house = await getHouseById(db, houseId);
  if (!house || house.worldId !== worldId) {
    throw Object.assign(new Error('House not found'), { status: 404 });
  }
  await db.collection('houses').updateOne(
    { _id: house._id },
    { $pull: { joinRequests: { uid } } }
  );
}

/** Assert that `uid` is the founder of the given house, returning the house. */
async function requireFounder(db, worldId, uid, houseId) {
  const house = await getHouseById(db, houseId);
  if (!house || house.worldId !== worldId) {
    throw Object.assign(new Error('House not found'), { status: 404 });
  }
  if (house.founderId !== uid) {
    throw Object.assign(new Error('Only the house founder can manage requests'), { status: 403 });
  }
  return house;
}

/** Founder approves a pending request, moving the applicant into membership. */
export async function approveJoinRequest(db, worldId, founderUid, houseId, applicantUid) {
  const house = await requireFounder(db, worldId, founderUid, houseId);
  const request = (house.joinRequests || []).find(r => r.uid === applicantUid);
  if (!request) {
    throw Object.assign(new Error('No such pending request'), { status: 404 });
  }

  // The applicant joins this house: clear them from any other house first.
  await leaveCurrentHouse(db, worldId, applicantUid);
  await clearPlayerRequests(db, worldId, applicantUid);

  await db.collection('houses').updateOne(
    { _id: house._id },
    { $push: { members: { uid: applicantUid, displayName: request.displayName, joinedAt: Date.now() } } }
  );
  return house;
}

/** Founder rejects a pending request, removing it. */
export async function rejectJoinRequest(db, worldId, founderUid, houseId, applicantUid) {
  const house = await requireFounder(db, worldId, founderUid, houseId);
  await db.collection('houses').updateOne(
    { _id: house._id },
    { $pull: { joinRequests: { uid: applicantUid } } }
  );
}
