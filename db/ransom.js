/**
 * Ransom — negotiate the fate of a captive between captor and captive.
 *
 * Schema (`ransom_offers`):
 *   _id, worldId, captiveUid, captorUid, amount, note, status, createdAt,
 *   settledAt?, history: [{ at, by, action, amount? }]
 *
 * Statuses: 'proposed' → 'counter' (any number of times) → 'accepted'|'rejected'.
 *
 * On accept: deduct `amount` from captive's gold, credit to captor.
 * If captive cannot pay, status falls to 'defaulted' and the captive is
 * marked dead (their character life ends).
 */
import { ObjectId } from 'mongodb';
import { addDeath } from './lives.js';
import { Ops } from '../lib/ops.js';
import { charge, pay } from './rewards.js';
import { settleCaptivity } from './captives.js';

export async function listFor(db, worldId, uid) {
  return db.collection('ransom_offers')
    .find({
      worldId,
      $or: [{ captiveUid: uid }, { captorUid: uid }],
      status: { $in: ['proposed', 'counter'] }
    })
    .sort({ createdAt: -1 })
    .toArray();
}

export async function propose(db, doc) {
  const insert = {
    worldId: doc.worldId,
    captiveUid: doc.captiveUid,
    captorUid: doc.captorUid,
    amount: Math.max(1, Math.floor(Number(doc.amount) || 0)),
    note: doc.note || '',
    status: 'proposed',
    history: [{ at: new Date(), by: doc.captorUid, action: 'proposed', amount: Math.floor(doc.amount) }],
    createdAt: new Date()
  };
  const r = await db.collection('ransom_offers').insertOne(insert);
  return { ...insert, _id: r.insertedId };
}

async function settle(db, ransom) {
  const { worldId, captiveUid, captorUid, amount } = ransom;

  const ops = new Ops();
  const charged = await charge(db, ops, worldId, captiveUid, { GOLD: amount });
  if (!charged.ok) {
    // captive defaults — life ends, body abandoned to the captor's mercy.
    await addDeath(db, worldId, captiveUid, {
      cause: 'ransom-default',
      by: captorUid,
      at: new Date()
    });
    await db.collection('ransom_offers').updateOne(
      { _id: ransom._id },
      {
        $set: { status: 'defaulted', settledAt: new Date(), defaultReason: charged.reason },
        $push: { history: { at: new Date(), by: captorUid, action: 'defaulted' } }
      }
    );
    await settleCaptivity(db, worldId, captiveUid, 'executed', 'ransom-default').catch(() => {});
    return { defaulted: true };
  }
  await pay(db, ops, worldId, captorUid, { GOLD: amount });
  await ops.flush(db);
  // A paid ransom frees the captive.
  await settleCaptivity(db, worldId, captiveUid, 'released', 'ransom-paid').catch(() => {});
  return { paid: amount };
}

export async function respond(db, ransomId, byUid, action, counter) {
  const _id = new ObjectId(ransomId);
  const ransom = await db.collection('ransom_offers').findOne({ _id });
  if (!ransom) throw new Error('ransom not found');
  if (!['proposed', 'counter'].includes(ransom.status)) throw new Error('ransom no longer open');

  if (byUid !== ransom.captiveUid && byUid !== ransom.captorUid) {
    throw new Error('only the captive or captor may respond');
  }

  if (action === 'accept') {
    const result = await settle(db, ransom);
    if (result.defaulted) {
      return { ...(await db.collection('ransom_offers').findOne({ _id })), defaulted: true };
    }
    await db.collection('ransom_offers').updateOne(
      { _id },
      {
        $set: { status: 'accepted', settledAt: new Date() },
        $push: { history: { at: new Date(), by: byUid, action: 'accepted' } }
      }
    );
    return db.collection('ransom_offers').findOne({ _id });
  }

  if (action === 'reject') {
    await db.collection('ransom_offers').updateOne(
      { _id },
      {
        $set: { status: 'rejected', settledAt: new Date() },
        $push: { history: { at: new Date(), by: byUid, action: 'rejected' } }
      }
    );
    return db.collection('ransom_offers').findOne({ _id });
  }

  if (action === 'counter') {
    const amount = Math.max(1, Math.floor(Number(counter) || 0));
    await db.collection('ransom_offers').updateOne(
      { _id },
      {
        $set: { status: 'counter', amount },
        $push: { history: { at: new Date(), by: byUid, action: 'counter', amount } }
      }
    );
    return db.collection('ransom_offers').findOne({ _id });
  }

  throw new Error(`unknown ransom action: ${action}`);
}
