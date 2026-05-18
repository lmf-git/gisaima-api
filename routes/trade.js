import { apiError } from '../core/auth.js';
import { listOpenOffers, listMyOffers, createOffer, setOfferStatus, acceptAndSettle } from '../db/trade.js';
import { getPlayerWorldData } from '../db/players.js';

export async function getOffers(db, worldId, uid) {
  const [items, mine] = await Promise.all([
    listOpenOffers(db, worldId),
    uid ? listMyOffers(db, worldId, uid) : Promise.resolve([])
  ]);
  return { items, mine };
}

export async function postOffer(db, auth, worldId, body) {
  const give = (body?.give || '').toString().trim().toUpperCase();
  const want = (body?.want || '').toString().trim().toUpperCase();
  const giveQty = Math.floor(Number(body?.giveQty));
  const wantQty = Math.floor(Number(body?.wantQty));

  if (!give || !want) throw apiError(400, 'give and want required');
  if (!Number.isFinite(giveQty) || giveQty <= 0) throw apiError(400, 'giveQty must be positive');
  if (!Number.isFinite(wantQty) || wantQty <= 0) throw apiError(400, 'wantQty must be positive');

  const me = await getPlayerWorldData(db, auth.uid, worldId);
  if (!me) throw apiError(403, 'must have joined this world');

  const doc = await createOffer(db, {
    worldId,
    give,
    giveQty,
    want,
    wantQty,
    postedBy: auth.uid,
    postedByName: me.displayName || 'Unknown'
  });

  return { ok: true, offer: doc };
}

export async function postOfferAction(db, auth, _worldId, offerId, action, body) {
  if (action === 'cancel') {
    const doc = await setOfferStatus(db, offerId, 'cancelled');
    if (!doc) throw apiError(409, 'offer not open');
    if (doc.postedBy !== auth.uid) throw apiError(403, 'only the poster may cancel');
    return { ok: true, offer: doc };
  }
  if (action === 'accept') {
    try {
      const r = await acceptAndSettle(db, offerId, auth.uid, { risk: body?.risk || 'safe' });
      if (!r.offer) throw apiError(409, 'offer not open');
      return { ok: true, offer: r.offer, transferred: r.transferred };
    } catch (e) {
      throw apiError(400, e.message);
    }
  }
  throw apiError(400, `unknown offer action: ${action}`);
}
