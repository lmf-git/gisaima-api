import { apiError } from '../core/auth.js';
import * as cosmetics from '../db/cosmetics.js';

export async function getCatalog(db, worldId, uid) {
  const owned = uid ? await cosmetics.listOwned(db, worldId, uid) : [];
  return { catalog: cosmetics.getCatalog(), owned };
}

export async function postPurchase(db, auth, worldId, body) {
  try {
    return await cosmetics.purchase(db, worldId, auth.uid, body?.key);
  } catch (e) {
    throw apiError(400, e.message);
  }
}

export async function postEquip(db, auth, worldId, body) {
  try {
    return await cosmetics.equip(db, worldId, auth.uid, body?.slot, body?.key);
  } catch (e) {
    throw apiError(400, e.message);
  }
}
