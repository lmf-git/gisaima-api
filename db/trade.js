import { ObjectId } from 'mongodb';
import { Ops } from '../lib/ops.js';
import { charge, resolveSink } from './rewards.js';
import { spawn as spawnCaravan } from './caravans.js';

// ── Trade offers ─────────────────────────────────────────────────────────────
// Schema:
//   _id        ObjectId
//   worldId    string
//   give       string  (resource key, e.g. 'WHEAT')
//   giveQty    number
//   giveKind   string  (icon hint: 'wheat'|'wood'|'stone'|'coin'...)
//   want       string
//   wantQty    number
//   wantKind   string
//   postedBy   string  (uid)
//   postedByName string
//   postedAt   Date
//   status     'open' | 'accepted' | 'cancelled'
//   acceptedBy string?
//   acceptedAt Date?

function kindHintFor(key) {
  const k = (key || '').toLowerCase();
  if (k.includes('wheat') || k.includes('grain') || k.includes('berry')) return 'wheat';
  if (k.includes('wood') || k.includes('stick') || k.includes('log')) return 'wood';
  if (k.includes('stone') || k.includes('ore') || k.includes('iron') || k.includes('crystal')) return 'stone';
  if (k.includes('coin') || k.includes('gold')) return 'coin';
  return 'scroll';
}

export async function listOpenOffers(db, worldId) {
  return db
    .collection('trade_offers')
    .find({ worldId, status: 'open' })
    .sort({ postedAt: -1 })
    .limit(100)
    .toArray();
}

export async function listMyOffers(db, worldId, uid) {
  return db
    .collection('trade_offers')
    .find({ worldId, postedBy: uid })
    .sort({ postedAt: -1 })
    .limit(50)
    .toArray();
}

export async function createOffer(db, doc) {
  const now = new Date();
  const insert = {
    worldId: doc.worldId,
    give: doc.give,
    giveQty: doc.giveQty,
    giveKind: kindHintFor(doc.give),
    want: doc.want,
    wantQty: doc.wantQty,
    wantKind: kindHintFor(doc.want),
    postedBy: doc.postedBy,
    postedByName: doc.postedByName,
    postedAt: now,
    status: 'open'
  };
  const r = await db.collection('trade_offers').insertOne(insert);
  return { ...insert, _id: r.insertedId };
}

export async function setOfferStatus(db, offerId, status, extra = {}) {
  const _id = new ObjectId(offerId);
  const r = await db.collection('trade_offers').findOneAndUpdate(
    { _id, status: 'open' },
    { $set: { status, ...extra } },
    { returnDocument: 'after' }
  );
  return r.value || r;
}

/**
 * Accept an offer and settle. Goods are NOT teleported — both sides have
 * their inventories charged from their reward sink (structure or group on the
 * map), and two physical caravan groups are spawned to walk the goods
 * between the two locations. The caravans are normal map groups and resolve
 * via the existing movement tick; on arrival, items are deposited into the
 * recipient's sink (see `db/caravans.deliver`, hooked from moveTick).
 *
 * `risk`:
 *   - 'safe'    — guaranteed delivery
 *   - 'caravan' — cheaper conceptually, but on arrival there is a 10% chance
 *                 the load is lost to the realm coffers (caravan ambushed).
 *
 * Returns { offer, caravans: [outbound, return] | null }.
 */
export async function acceptAndSettle(db, offerId, takerUid, { risk = 'safe' } = {}) {
  const _id = new ObjectId(offerId);
  const offer = await db.collection('trade_offers').findOne({ _id });
  if (!offer || offer.status !== 'open') return { offer: null, caravans: null };
  if (offer.postedBy === takerUid) throw new Error('cannot accept your own offer');

  const posterSink = await resolveSink(db, offer.worldId, offer.postedBy);
  const takerSink  = await resolveSink(db, offer.worldId, takerUid);
  if (!posterSink) throw new Error('poster has no resolvable storage location');
  if (!takerSink)  throw new Error('you have no resolvable storage location at your current position');

  // Charge both sides — fails atomically if either lacks the goods.
  const ops = new Ops();
  const chargePoster = await charge(db, ops, offer.worldId, offer.postedBy, { [offer.give]: offer.giveQty });
  if (!chargePoster.ok) throw new Error(`poster: ${chargePoster.reason}`);
  const chargeTaker = await charge(db, ops, offer.worldId, takerUid, { [offer.want]: offer.wantQty });
  if (!chargeTaker.ok) throw new Error(`you: ${chargeTaker.reason}`);

  // Spawn the two caravans, each walking the goods to the other side's tile.
  const [px, py] = posterSink.tileKey.split(',').map(Number);
  const [tx, ty] = takerSink.tileKey.split(',').map(Number);

  const outbound = await spawnCaravan(db, ops, offer.worldId, {
    fromX: px, fromY: py,
    toX:   tx, toY:   ty,
    items: { [offer.give]: offer.giveQty },
    ownerUid: offer.postedBy,
    toUid: takerUid,
    risk
  });

  const returnLeg = await spawnCaravan(db, ops, offer.worldId, {
    fromX: tx, fromY: ty,
    toX:   px, toY:   py,
    items: { [offer.want]: offer.wantQty },
    ownerUid: takerUid,
    toUid: offer.postedBy,
    risk
  });

  await ops.flush(db);

  const finalised = await setOfferStatus(db, offerId, 'accepted', {
    acceptedBy: takerUid,
    acceptedAt: new Date(),
    risk,
    caravans: { outbound, returnLeg }
  });
  return { offer: finalised, caravans: [outbound, returnLeg] };
}
