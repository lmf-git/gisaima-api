/**
 * Per-world friendships and friend requests.
 *
 * Collections:
 *   friends         { worldId, users: [a, b] (sorted), since }
 *   friendRequests  { worldId, from, to, createdAt }
 *
 * Friendships are symmetric; `users` is always stored sorted so a single
 * document represents the pair regardless of direction.
 */

function pair(a, b) {
  return [a, b].sort();
}

export async function areFriends(db, worldId, a, b) {
  if (!a || !b || a === b) return false;
  const doc = await db.collection('friends').findOne({ worldId, users: pair(a, b) });
  return !!doc;
}

export async function listFriends(db, worldId, uid) {
  const docs = await db.collection('friends').find({ worldId, users: uid }).toArray();
  return docs.map(d => d.users.find(u => u !== uid)).filter(Boolean);
}

export async function listRequests(db, worldId, uid) {
  const docs = await db.collection('friendRequests')
    .find({ worldId, $or: [{ from: uid }, { to: uid }] })
    .toArray();
  return {
    incoming: docs.filter(d => d.to === uid).map(d => ({ from: d.from, createdAt: d.createdAt })),
    outgoing: docs.filter(d => d.from === uid).map(d => ({ to: d.to, createdAt: d.createdAt })),
  };
}

/**
 * Send a friend request. If the target has already requested the sender,
 * the friendship is established immediately instead.
 * @returns {{ status: 'friends' | 'requested' | 'exists' }}
 */
export async function sendRequest(db, worldId, from, to) {
  if (!to || from === to) throw Object.assign(new Error('invalid target'), { status: 400 });
  if (await areFriends(db, worldId, from, to)) return { status: 'exists' };

  // Reciprocal request already pending → become friends.
  const reciprocal = await db.collection('friendRequests').findOne({ worldId, from: to, to: from });
  if (reciprocal) {
    await acceptRequest(db, worldId, to, from);
    return { status: 'friends' };
  }

  await db.collection('friendRequests').updateOne(
    { worldId, from, to },
    { $setOnInsert: { worldId, from, to, createdAt: Date.now() } },
    { upsert: true }
  );
  return { status: 'requested' };
}

/** `to` accepts the request from `from`. */
export async function acceptRequest(db, worldId, from, to) {
  const req = await db.collection('friendRequests').findOne({ worldId, from, to });
  if (!req) throw Object.assign(new Error('no such request'), { status: 404 });

  await db.collection('friends').updateOne(
    { worldId, users: pair(from, to) },
    { $setOnInsert: { worldId, users: pair(from, to), since: Date.now() } },
    { upsert: true }
  );
  await db.collection('friendRequests').deleteMany({
    worldId,
    $or: [{ from, to }, { from: to, to: from }],
  });
  return { status: 'friends' };
}

/** `to` declines (or `from` cancels) the request. */
export async function declineRequest(db, worldId, from, to) {
  await db.collection('friendRequests').deleteOne({ worldId, from, to });
  return { status: 'declined' };
}

export async function removeFriend(db, worldId, a, b) {
  await db.collection('friends').deleteOne({ worldId, users: pair(a, b) });
  return { status: 'removed' };
}
