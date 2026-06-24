import * as marriage from '../db/marriage.js';
import { Ops } from '../lib/ops.js';

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

/** Resolve display names for a list of uids in one query. */
async function nameMap(db, worldId, uids) {
  const ids = [...new Set(uids)].filter(Boolean);
  if (!ids.length) return {};
  const docs = await db.collection('players').find(
    { _id: { $in: ids } },
    { projection: { _id: 1, [`worlds.${worldId}.displayName`]: 1 } }
  ).toArray();
  const map = {};
  for (const d of docs) map[d._id] = d.worlds?.[worldId]?.displayName || 'Unknown';
  return map;
}

// Announce a sealed marriage in world chat — at the couple's location if known.
function announce(ops, worldId, r, byUid) {
  const [n1, n2] = r.names;
  ops.chat(worldId, {
    location: r.location || undefined,
    text: `💍 ${n1} and ${n2} are wed!`,
    timestamp: Date.now(),
    type: 'event',
    category: 'player',
    userId: byUid,
  });
}

export async function getMarriageProposals(db, auth, worldId) {
  const { incoming, outgoing } = await marriage.listProposals(db, worldId, auth.uid);
  const names = await nameMap(db, worldId, [...incoming.map(r => r.from), ...outgoing.map(r => r.to)]);
  return {
    incoming: incoming.map(r => ({ ...r, displayName: names[r.from] || 'Unknown' })),
    outgoing: outgoing.map(r => ({ ...r, displayName: names[r.to] || 'Unknown' })),
  };
}

export async function postProposeMarriage(db, auth, worldId, body) {
  const toUid = body?.toUid;
  if (!toUid) throw err(400, 'toUid required');
  if (toUid === auth.uid) throw err(400, 'you cannot wed yourself');

  const r = await marriage.propose(db, worldId, auth.uid, toUid);
  const ops = new Ops();
  if (r.status === 'married') {
    // Reciprocal proposal existed — sealed immediately.
    announce(ops, worldId, r, auth.uid);
    ops.report(toUid, worldId, {
      type: 'marriage_accepted',
      title: 'You are wed',
      summary: `${r.names.join(' and ')} are now married.`,
    });
  } else {
    ops.report(toUid, worldId, {
      type: 'marriage_proposal',
      title: 'A proposal of marriage',
      summary: `${r.fromLifeName} asks for your hand. Answer in the Friends hall.`,
    });
  }
  await ops.flush(db);
  return r;
}

export async function postAcceptMarriage(db, auth, worldId, proposerUid) {
  if (!proposerUid) throw err(400, 'proposer uid required');
  const r = await marriage.accept(db, worldId, auth.uid, proposerUid);
  const ops = new Ops();
  announce(ops, worldId, r, auth.uid);
  ops.report(proposerUid, worldId, {
    type: 'marriage_accepted',
    title: 'Your proposal was accepted',
    summary: `${r.names.join(' and ')} are now wed!`,
  });
  await ops.flush(db);
  return r;
}

export async function postDeclineMarriage(db, auth, worldId, otherUid) {
  if (!otherUid) throw err(400, 'uid required');
  // Either party may clear the pending proposal (decline incoming / cancel outgoing).
  const { declined } = await marriage.decline(db, worldId, auth.uid, otherUid);
  await marriage.cancel(db, worldId, auth.uid, otherUid);
  if (declined) {
    const ops = new Ops();
    ops.report(otherUid, worldId, {
      type: 'marriage_declined',
      title: 'Your proposal was declined',
      summary: 'Your offer of marriage was turned down.',
    });
    await ops.flush(db);
  }
  return { status: 'declined' };
}
