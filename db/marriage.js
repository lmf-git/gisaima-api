/**
 * Marriage proposals between players.
 *
 * Unlike the old instant, same-tile `lives.marry`, a marriage is now courted:
 * one player proposes to a friend, the other accepts or declines. Only then are
 * the two controlled characters wed (mutual `spouseLifeId`). Friendship is the
 * only gate — no co-location required.
 *
 * Collection:
 *   marriageProposals { worldId, from (uid), to (uid), fromLifeId, fromLifeName, createdAt }
 *
 * A proposal records the proposer's *betrothed* life (snapshotted at propose
 * time); the accepter is wed with whichever character they control when they
 * accept.
 */
import { ObjectId } from 'mongodb';
import { areFriends } from './friends.js';

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

// The character a player is currently driving in this world.
async function controlledLife(db, worldId, uid) {
  const p = await db.collection('players').findOne(
    { _id: uid },
    { projection: { [`worlds.${worldId}.controlledLifeId`]: 1 } }
  );
  const lifeId = p?.worlds?.[worldId]?.controlledLifeId;
  if (!lifeId) return null;
  return db.collection('lives').findOne({ _id: new ObjectId(lifeId), worldId });
}

export async function listProposals(db, worldId, uid) {
  const docs = await db.collection('marriageProposals')
    .find({ worldId, $or: [{ from: uid }, { to: uid }] })
    .toArray();
  return {
    incoming: docs.filter(d => d.to === uid).map(d => ({ from: d.from, fromLifeName: d.fromLifeName, createdAt: d.createdAt })),
    outgoing: docs.filter(d => d.from === uid).map(d => ({ to: d.to, createdAt: d.createdAt })),
  };
}

/**
 * Propose marriage. The two players must already be friends, and both must have
 * a living, unmarried controlled character. If the target has already proposed
 * to the caller, the marriage is sealed immediately instead.
 * @returns {{ status: 'proposed' | 'married', ... }}
 */
export async function propose(db, worldId, fromUid, toUid) {
  if (!toUid || fromUid === toUid) throw err(400, 'invalid target');
  if (!(await areFriends(db, worldId, fromUid, toUid))) throw err(400, 'you must be friends before proposing');

  const fromLife = await controlledLife(db, worldId, fromUid);
  const toLife   = await controlledLife(db, worldId, toUid);
  if (!fromLife) throw err(400, 'you have no living character to wed');
  if (!toLife)   throw err(400, 'they have no living character to wed');
  if (fromLife.died) throw err(400, 'your character has died');
  if (toLife.died)   throw err(400, 'their character has died');
  if (fromLife.spouseLifeId) throw err(400, 'your character is already married');
  if (toLife.spouseLifeId)   throw err(400, 'their character is already married');

  // Reciprocal proposal already pending → seal the marriage now.
  const reciprocal = await db.collection('marriageProposals').findOne({ worldId, from: toUid, to: fromUid });
  if (reciprocal) return accept(db, worldId, fromUid, toUid);

  await db.collection('marriageProposals').updateOne(
    { worldId, from: fromUid, to: toUid },
    { $setOnInsert: { worldId, from: fromUid, to: toUid, fromLifeId: fromLife._id, fromLifeName: fromLife.name, createdAt: Date.now() } },
    { upsert: true }
  );
  return { status: 'proposed', fromLifeName: fromLife.name, toLifeName: toLife.name };
}

/**
 * `accepterUid` accepts the proposal made by `proposerUid`. Weds the proposer's
 * betrothed life to the accepter's currently-controlled life.
 */
export async function accept(db, worldId, accepterUid, proposerUid) {
  const prop = await db.collection('marriageProposals').findOne({ worldId, from: proposerUid, to: accepterUid });
  if (!prop) throw err(404, 'no such proposal');

  const a = await db.collection('lives').findOne({ _id: new ObjectId(prop.fromLifeId), worldId });
  const b = await controlledLife(db, worldId, accepterUid);
  if (!a || !b) throw err(400, 'a character could not be found');
  if (a.died || b.died) throw err(400, 'a character has died');
  if (a.spouseLifeId || b.spouseLifeId) throw err(400, 'a character is already married');

  const marriedAt = new Date();
  await db.collection('lives').updateOne({ _id: a._id }, { $set: { spouseLifeId: b._id, marriedAt } });
  await db.collection('lives').updateOne({ _id: b._id }, { $set: { spouseLifeId: a._id, marriedAt } });
  await db.collection('marriageProposals').deleteMany({
    worldId,
    $or: [{ from: proposerUid, to: accepterUid }, { from: accepterUid, to: proposerUid }],
  });

  return {
    status: 'married',
    proposerUid, accepterUid,
    names: [a.name, b.name],
    location: b.lastLocation || a.lastLocation || null,
  };
}

/** `accepterUid` declines an incoming proposal from `proposerUid`. */
export async function decline(db, worldId, accepterUid, proposerUid) {
  const res = await db.collection('marriageProposals').deleteOne({ worldId, from: proposerUid, to: accepterUid });
  return { declined: res.deletedCount > 0 };
}

/** `fromUid` withdraws their own outgoing proposal to `toUid`. */
export async function cancel(db, worldId, fromUid, toUid) {
  await db.collection('marriageProposals').deleteOne({ worldId, from: fromUid, to: toUid });
  return { cancelled: true };
}

/** Clear any pending proposals between two players (e.g. when they un-friend). */
export async function clearBetween(db, worldId, a, b) {
  await db.collection('marriageProposals').deleteMany({
    worldId,
    $or: [{ from: a, to: b }, { from: b, to: a }],
  });
}
