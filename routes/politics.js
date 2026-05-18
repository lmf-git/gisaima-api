import { apiError } from '../core/auth.js';
import { listOpenVotes, castVote, getCoffers } from '../db/politics.js';

export async function getPolitics(db, worldId) {
  const [votes, coffers] = await Promise.all([
    listOpenVotes(db, worldId),
    getCoffers(db, worldId)
  ]);
  return { votes, coffers };
}

export async function postVote(db, auth, worldId, voteId, body) {
  const option = (body?.option || '').toString();
  if (!option) throw apiError(400, 'option required');
  const r = await castVote(db, voteId, auth.uid, option);
  if (!r) throw apiError(404, 'vote not found or closed');
  return { ok: true, vote: r };
}
