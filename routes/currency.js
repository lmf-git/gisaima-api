import { apiError } from '../core/auth.js';
import * as currency from '../db/currency.js';

export async function getList(db, worldId) {
  return { items: await currency.listFor(db, worldId) };
}

export async function postCreate(db, auth, worldId, body) {
  try {
    const doc = await currency.create(db, {
      worldId, issuerUid: auth.uid,
      structureKey: body?.structureKey,
      name: body?.name,
      symbol: body?.symbol,
      exchange: body?.exchange
    });
    return { ok: true, currency: doc };
  } catch (e) {
    throw apiError(400, e.message);
  }
}

export async function postSetOfficial(db, _auth, worldId, currencyId, body) {
  try {
    return await currency.setOfficial(db, worldId, body?.structureKey, currencyId);
  } catch (e) {
    throw apiError(400, e.message);
  }
}
