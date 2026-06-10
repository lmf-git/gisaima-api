import { apiError } from '../core/auth.js';
import {
  listOpenVotes, castVote, getCoffers, proposeVote,
  listOpenElections, callElection, castElectionVote,
} from '../db/politics.js';
import { getWorldDoc } from '../db/worlds.js';

export async function getPolitics(db, worldId) {
  const [votes, coffers, world, elections] = await Promise.all([
    listOpenVotes(db, worldId),
    getCoffers(db, worldId),
    getWorldDoc(db, worldId),
    listOpenElections(db, worldId)
  ]);
  const now = Date.now();
  const info = world?.info || {};
  return {
    votes,
    coffers,
    elections,
    // Active treasury effects so the client can show the loop's payoff.
    effects: {
      festival: info.festivalUntil > now ? info.festivalUntil : null,
      publicWorks: info.publicWorksUntil > now ? info.publicWorksUntil : null,
      bountyPool: info.bountyPool || 0,
    }
  };
}

export async function postProposeVote(db, auth, worldId, body) {
  try {
    const vote = await proposeVote(db, worldId, auth.uid, body || {});
    return { ok: true, vote };
  } catch (e) {
    throw apiError(400, e.message || 'could not create proposal');
  }
}

export async function postVote(db, auth, worldId, voteId, body) {
  const option = (body?.option || '').toString();
  if (!option) throw apiError(400, 'option required');
  const r = await castVote(db, voteId, auth.uid, option);
  if (!r) throw apiError(404, 'vote not found or closed');
  return { ok: true, vote: r };
}

export async function postCallElection(db, auth, worldId, body) {
  try {
    const election = await callElection(db, worldId, auth.uid, body || {});
    return { ok: true, election };
  } catch (e) {
    throw apiError(400, e.message || 'could not call election');
  }
}

export async function postElectionVote(db, auth, worldId, electionId, body) {
  try {
    const r = await castElectionVote(db, electionId, auth.uid, (body?.candidateUid || '').toString());
    if (!r) throw apiError(404, 'election not found or closed');
    return { ok: true, election: r };
  } catch (e) {
    if (e.status) throw e;
    throw apiError(400, e.message || 'could not vote');
  }
}
