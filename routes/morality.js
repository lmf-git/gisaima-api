import { apiError } from '../core/auth.js';
import * as morality from '../db/morality.js';

export async function getIndex(db, worldId, uid) {
  const [scores, mine] = await Promise.all([
    morality.listScores(db, worldId, 50),
    uid ? morality.getFor(db, worldId, uid) : Promise.resolve(null)
  ]);
  return { scores, mine };
}

export async function postAccusation(db, auth, worldId, body) {
  const targetUid = (body?.targetUid || '').toString();
  if (!targetUid) throw apiError(400, 'targetUid required');
  try {
    return await morality.accuse(db, worldId, auth.uid, targetUid, body?.polarity, body?.reportRef, body?.comment);
  } catch (e) {
    throw apiError(400, e.message);
  }
}

export async function getHistory(db, worldId, uid) {
  return morality.history(db, worldId, uid);
}
