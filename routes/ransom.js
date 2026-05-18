import { apiError } from '../core/auth.js';
import * as ransom from '../db/ransom.js';

export async function getList(db, worldId, uid) {
  if (!uid) return { items: [] };
  return { items: await ransom.listFor(db, worldId, uid) };
}

export async function postProposal(db, auth, worldId, body) {
  const captiveUid = body?.captiveUid || '';
  const captorUid  = body?.captorUid  || auth.uid;
  if (!captiveUid) throw apiError(400, 'captiveUid required');
  if (captorUid === captiveUid) throw apiError(400, 'captor and captive must differ');
  if (captorUid !== auth.uid && captiveUid !== auth.uid) {
    throw apiError(403, 'must be a party to the ransom');
  }
  const doc = await ransom.propose(db, { worldId, captiveUid, captorUid, amount: body.amount, note: body.note });
  return { ok: true, ransom: doc };
}

export async function postResponse(db, auth, _worldId, ransomId, body) {
  try {
    const r = await ransom.respond(db, ransomId, auth.uid, body?.action, body?.counter);
    return { ok: true, ransom: r };
  } catch (e) {
    throw apiError(400, e.message);
  }
}
