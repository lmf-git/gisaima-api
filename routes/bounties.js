import { apiError } from '../core/auth.js';
import { listOpenBounties, createBounty, claimBounty } from '../db/bounties.js';
import { getPlayerWorldData } from '../db/players.js';

export async function getBounties(db, worldId) {
  const items = await listOpenBounties(db, worldId);
  return { items };
}

export async function postBounty(db, auth, worldId, body) {
  const targetUid = (body?.targetUid || '').trim();
  const targetName = (body?.targetName || '').trim();
  const amount = Number(body?.amount);

  if (!targetUid) throw apiError(400, 'targetUid required');
  if (!targetName) throw apiError(400, 'targetName required');
  if (!Number.isFinite(amount) || amount <= 0) throw apiError(400, 'amount must be positive');
  if (targetUid === auth.uid) throw apiError(400, 'cannot post a bounty on yourself');

  const issuer = await getPlayerWorldData(db, auth.uid, worldId);
  if (!issuer) throw apiError(403, 'must have joined this world to post a bounty');

  const target = await getPlayerWorldData(db, targetUid, worldId);
  if (!target) throw apiError(404, 'target has not joined this world');

  const doc = await createBounty(db, {
    worldId,
    targetUid,
    targetName,
    amount: Math.floor(amount),
    postedBy: auth.uid,
    postedByName: issuer.displayName || 'Unknown'
  });

  return { ok: true, bounty: doc };
}

export async function postBountyClaim(db, auth, _worldId, bountyId) {
  if (!bountyId) throw apiError(400, 'bountyId required');
  const doc = await claimBounty(db, bountyId, auth.uid);
  if (!doc) throw apiError(409, 'bounty no longer open');
  return { ok: true, bounty: doc };
}
