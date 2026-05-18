import { ObjectId } from 'mongodb';

// ── Bounties (per-world contracts on player heads) ───────────────────────────
// Schema:
//   _id          ObjectId
//   worldId      string
//   targetUid    string   — uid of hunted player
//   targetName   string   — denormalised display name at posting time
//   amount       number   — gold reward
//   postedBy     string   — uid of issuer
//   postedByName string
//   postedAt     Date
//   status       'open' | 'claimed' | 'expired'
//   claimedBy    string?  (uid)
//   claimedAt    Date?

export async function listOpenBounties(db, worldId) {
  return db
    .collection('bounties')
    .find({ worldId, status: 'open' })
    .sort({ amount: -1, postedAt: -1 })
    .limit(100)
    .toArray();
}

export async function createBounty(db, doc) {
  const now = new Date();
  const insert = {
    worldId: doc.worldId,
    targetUid: doc.targetUid,
    targetName: doc.targetName,
    amount: doc.amount,
    postedBy: doc.postedBy,
    postedByName: doc.postedByName,
    postedAt: now,
    status: 'open'
  };
  const r = await db.collection('bounties').insertOne(insert);
  return { ...insert, _id: r.insertedId };
}

export async function claimBounty(db, bountyId, claimerUid) {
  const _id = new ObjectId(bountyId);
  const r = await db.collection('bounties').findOneAndUpdate(
    { _id, status: 'open' },
    { $set: { status: 'claimed', claimedBy: claimerUid, claimedAt: new Date() } },
    { returnDocument: 'after' }
  );
  return r.value || r; // mongo driver versions differ
}

export async function getBountiesOnTarget(db, worldId, targetUid) {
  return db.collection('bounties').find({ worldId, targetUid, status: 'open' }).toArray();
}

/**
 * Called from battleTick when a player is killed. Atomically marks every open
 * bounty on the victim as claimed, totals the reward, and deposits it as
 * `GOLD` items into the killer's reward sink — the structure the killer is
 * currently standing on, the group they're in, or their first founded home
 * structure (in that order). Returns:
 *
 *   { total, sink: { kind, chunkKey, tileKey } | null }
 *
 * Gold lives inside structures/groups on chunk tiles — there is no global
 * player wallet. No-op when the kill was not attributable (no killerUid).
 */
import { pay } from './rewards.js';

export async function settleBountiesForKill(db, ops, worldId, victimUid, killerUid) {
  if (!victimUid || !killerUid) return { total: 0, sink: null };

  const now = new Date();
  const bounties = await db
    .collection('bounties')
    .find({ worldId, targetUid: victimUid, status: 'open' })
    .toArray();
  if (!bounties.length) return { total: 0, sink: null };

  const ids = bounties.map((b) => b._id);
  await db.collection('bounties').updateMany(
    { _id: { $in: ids } },
    { $set: { status: 'claimed', claimedBy: killerUid, claimedAt: now } }
  );

  const total = bounties.reduce((acc, b) => acc + (Number(b.amount) || 0), 0);
  let sink = null;
  if (total > 0) {
    sink = await pay(db, ops, worldId, killerUid, { GOLD: total });
  }
  return { total, sink };
}
