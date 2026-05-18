import { apiError } from '../core/auth.js';
import * as trails from '../db/trails.js';

export async function getList(db, worldId, uid) {
  if (!uid) return { items: [] };
  return { items: await trails.listFor(db, worldId, uid) };
}

export async function postCreate(db, auth, worldId, body) {
  const doc = await trails.create(db, {
    worldId,
    ownerUid: auth.uid,
    kind: body?.kind || 'anagram',
    seedString: body?.seedString,
    originX: body?.originX,
    originY: body?.originY,
    rewardItem: body?.rewardItem
  });
  return { ok: true, trail: doc };
}

export async function postSolve(db, _auth, _worldId, trailId, body) {
  const idx = Number(body?.stepIndex);
  if (!Number.isFinite(idx) || idx < 0) throw apiError(400, 'stepIndex required');
  const r = await trails.solveStep(db, trailId, idx);
  if (!r) throw apiError(404, 'trail not found');
  return { ok: true, trail: r };
}
