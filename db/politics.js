import { ObjectId } from 'mongodb';

// ── Politics: votes & coffers ────────────────────────────────────────────────
// votes schema:
//   _id        ObjectId
//   worldId    string
//   title      string
//   description string
//   options    [{ id, label }]
//   tallies    { [optionId]: number }
//   voters     { [uid]: optionId }
//   openedAt   Date
//   closesAt   Date | null
//   status     'open' | 'closed'

export async function listOpenVotes(db, worldId) {
  const docs = await db
    .collection('votes')
    .find({ worldId, status: 'open' })
    .sort({ openedAt: -1 })
    .limit(50)
    .toArray();

  return docs.map((d) => {
    const totals = d.tallies || {};
    const grandTotal = Object.values(totals).reduce((a, b) => a + (b || 0), 0) || 1;
    return {
      _id: d._id,
      title: d.title,
      description: d.description,
      closesAt: d.closesAt,
      options: (d.options || []).map((o) => ({
        id: o.id,
        label: o.label,
        count: totals[o.id] || 0,
        share: (totals[o.id] || 0) / grandTotal
      }))
    };
  });
}

export async function castVote(db, voteId, uid, option) {
  const _id = new ObjectId(voteId);
  const doc = await db.collection('votes').findOne({ _id });
  if (!doc || doc.status !== 'open') return null;

  const prev = doc.voters?.[uid];
  const $inc = { [`tallies.${option}`]: 1 };
  const $set = { [`voters.${uid}`]: option };
  if (prev && prev !== option) $inc[`tallies.${prev}`] = -1;

  const r = await db.collection('votes').findOneAndUpdate(
    { _id },
    { $inc, $set },
    { returnDocument: 'after' }
  );
  return r.value || r;
}

export async function getCoffers(db, worldId) {
  const doc = await db.collection('coffers').findOne({ _id: worldId });
  return doc || { _id: worldId, gold: 0, taxes: 0, debt: 0 };
}

export async function donateToCoffers(db, worldId, amount, fromUid = null) {
  const amt = Math.max(1, Math.floor(amount));
  if (fromUid) {
    const player = await db.collection('players').findOne(
      { _id: fromUid },
      { projection: { [`worlds.${worldId}.gold`]: 1 } }
    );
    const gold = player?.worlds?.[worldId]?.gold ?? 0;
    if (gold < amt) throw new Error('insufficient gold to donate');
    await db.collection('players').updateOne(
      { _id: fromUid },
      { $inc: { [`worlds.${worldId}.gold`]: -amt } }
    );
  }
  await db.collection('coffers').updateOne(
    { _id: worldId },
    { $inc: { gold: amt } },
    { upsert: true }
  );
  return getCoffers(db, worldId);
}

// ── Proposals (vote creation) ────────────────────────────────────────────────
// A vote can carry a `proposal` describing a treasury spend executed when it
// passes — this is what gives the council teeth and gives the coffers a sink.
//
// proposal schema:
//   kind    'festival' | 'bounty' | 'public_works'
//   cost    { gold?: number, items?: { CODE: qty } }   — paid from coffers on pass
//   params  kind-specific (e.g. { durationMs })

const PROPOSAL_KINDS = {
  // Boosts passive production world-wide for a time.
  festival:      { defaultDurationMs: 60 * 60 * 1000 },
  // Moves spent gold into a bounty pool that pays players for slaying monsters.
  bounty:        {},
  // Funds a temporary realm-wide defensive bonus.
  public_works:  { defaultDurationMs: 60 * 60 * 1000 },
};

const DEFAULT_VOTE_DURATION_MS = 60 * 60 * 1000; // 1h

export async function proposeVote(db, worldId, uid, body = {}) {
  const title = (body.title || '').toString().trim();
  if (!title) throw new Error('title required');
  const kind = (body.kind || '').toString();
  const proposalDef = PROPOSAL_KINDS[kind];
  if (!proposalDef) throw new Error(`unknown proposal kind: ${kind}`);

  const cost = sanitizeCost(body.cost);
  if (!cost.gold && !Object.keys(cost.items).length) throw new Error('a proposal must spend something');

  // Kind-specific required parameters: a bounty must name its quarry, and a
  // public-works motion must name the building/upgrade it funds.
  const rawParams = body.params && typeof body.params === 'object' ? body.params : {};
  const params = {};
  if (kind === 'bounty') {
    const targetUid = (rawParams.targetUid || '').toString();
    if (!targetUid) throw new Error('a bounty must name the player it targets');
    params.targetUid = targetUid;
    params.targetName = (rawParams.targetName || '').toString().slice(0, 80) || targetUid;
  } else if (kind === 'public_works') {
    const building = (rawParams.building || '').toString();
    if (!building) throw new Error('public works must name the building or upgrade it funds');
    params.building = building.slice(0, 80);
    params.buildingName = (rawParams.buildingName || '').toString().slice(0, 80) || building;
  }
  if (Number.isFinite(Number(rawParams.durationMs))) params.durationMs = Number(rawParams.durationMs);

  const durationMs = clampDuration(body.durationMs);
  const now = new Date();
  const doc = {
    worldId,
    title,
    description: (body.description || '').toString().slice(0, 500),
    proposedBy: uid,
    kind,
    cost,
    params,
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'reject',  label: 'Reject' },
    ],
    tallies: {},
    voters: {},
    openedAt: now,
    closesAt: new Date(now.getTime() + durationMs),
    status: 'open',
    executed: false,
  };
  const r = await db.collection('votes').insertOne(doc);
  return { _id: r.insertedId, ...doc };
}

function sanitizeCost(cost) {
  const out = { gold: 0, items: {} };
  if (!cost || typeof cost !== 'object') return out;
  out.gold = Math.max(0, Math.floor(Number(cost.gold) || 0));
  if (cost.items && typeof cost.items === 'object') {
    for (const [k, v] of Object.entries(cost.items)) {
      const q = Math.max(0, Math.floor(Number(v) || 0));
      if (q > 0) out.items[k.toUpperCase()] = q;
    }
  }
  return out;
}

function clampDuration(ms) {
  const n = Math.floor(Number(ms) || 0);
  if (!n) return DEFAULT_VOTE_DURATION_MS;
  return Math.min(24 * 60 * 60 * 1000, Math.max(5 * 60 * 1000, n));
}

/**
 * Atomically spend from the world coffers if affordable. Coffers hold `gold`
 * (number) and `items` (code → qty). Returns true on success.
 */
export async function spendCoffers(db, worldId, cost) {
  const c = sanitizeCost(cost);
  const filter = { _id: worldId };
  const dec = {};
  if (c.gold) { filter.gold = { $gte: c.gold }; dec.gold = -c.gold; }
  for (const [code, qty] of Object.entries(c.items)) {
    filter[`items.${code}`] = { $gte: qty };
    dec[`items.${code}`] = -qty;
  }
  if (!Object.keys(dec).length) return true;
  const r = await db.collection('coffers').updateOne(filter, { $inc: dec });
  return r.modifiedCount > 0;
}

/** Apply a passed proposal's effect. Assumes cost has already been spent. */
async function applyProposalEffect(db, worldId, vote, now) {
  const ms = now.getTime();
  if (vote.kind === 'festival') {
    const dur = clampDuration(vote.params?.durationMs ?? PROPOSAL_KINDS.festival.defaultDurationMs);
    await db.collection('worlds').updateOne(
      { _id: worldId }, { $set: { 'info.festivalUntil': ms + dur } }, { upsert: true });
  } else if (vote.kind === 'public_works') {
    const dur = clampDuration(vote.params?.durationMs ?? PROPOSAL_KINDS.public_works.defaultDurationMs);
    await db.collection('worlds').updateOne(
      { _id: worldId }, { $set: { 'info.publicWorksUntil': ms + dur } }, { upsert: true });
  } else if (vote.kind === 'bounty') {
    const gold = vote.cost?.gold || 0;
    const targetUid = vote.params?.targetUid;
    if (targetUid) {
      // A targeted bounty posts a real contract on the named player's head,
      // claimable by whoever slays them (see settleBountiesForKill).
      const { createBounty } = await import('./bounties.js');
      await createBounty(db, {
        worldId,
        targetUid,
        targetName: vote.params?.targetName || targetUid,
        amount: gold,
        postedBy: 'council',
        postedByName: 'The Council',
      });
    } else {
      // Untargeted: seed the generic monster-slaying pool.
      await db.collection('worlds').updateOne(
        { _id: worldId }, { $inc: { 'info.bountyPool': gold } }, { upsert: true });
    }
  }
}

/**
 * Tick: closes any open votes whose `closesAt` has passed, finalising tallies.
 * A passed spend-proposal (approve outright wins, ≥1 vote) has its cost drawn
 * from the coffers and its effect applied. Returns the number of votes closed.
 */
export async function tickClosure(db, worldId, now = new Date()) {
  const closing = await db.collection('votes')
    .find({ worldId, status: 'open', closesAt: { $ne: null, $lte: now } })
    .toArray();
  if (!closing.length) return 0;

  for (const vote of closing) {
    const tallies = vote.tallies || {};
    const approve = tallies.approve || 0;
    const reject  = tallies.reject || 0;
    const passed  = approve > 0 && approve > reject;

    let outcome = 'rejected';
    if (passed) {
      const spent = await spendCoffers(db, worldId, vote.cost);
      if (spent) {
        await applyProposalEffect(db, worldId, vote, now);
        outcome = 'enacted';
      } else {
        outcome = 'insufficient_funds';
      }
    }

    await db.collection('votes').updateOne(
      { _id: vote._id },
      { $set: { status: 'closed', closedAt: now, executed: outcome === 'enacted', outcome } }
    );
  }
  return closing.length;
}

// ── Elections (notes: SPAWN STRUCTURE POLITICS) ──────────────────────────────
// Any player may call an election at a player-owned structure — this doubles
// as the vote of no confidence. Players then vote for a candidate (voting for
// someone nominates them); when the election closes, stewardship of the
// structure transfers to the winner. Ties keep the incumbent. A structure can
// hold at most one open election, with a cooldown between elections.
//
// elections schema:
//   _id, worldId, chunkKey, tileKey, location {x,y}, structureName,
//   incumbentUid, calledBy, candidates { uid: name }, tallies { uid: n },
//   voters { uid: candidateUid }, openedAt, closesAt, status 'open'|'closed',
//   winnerUid?, outcome?

const ELECTION_DURATION_MS = 60 * 60 * 1000;       // 1h
const ELECTION_COOLDOWN_MS = 24 * 60 * 60 * 1000;  // one per structure per day

export async function listOpenElections(db, worldId) {
  const docs = await db.collection('elections')
    .find({ worldId, status: 'open' })
    .sort({ openedAt: -1 })
    .limit(50)
    .toArray();
  return docs.map(d => ({
    _id: d._id,
    structureName: d.structureName,
    location: d.location,
    incumbentUid: d.incumbentUid,
    closesAt: d.closesAt,
    candidates: Object.entries(d.candidates || {}).map(([uid, name]) => ({
      uid, name, count: d.tallies?.[uid] || 0
    })),
  }));
}

export async function callElection(db, worldId, uid, body = {}) {
  const { getChunkKey } = await import('gisaima-shared/map/cartography.js');
  const x = Number(body.x), y = Number(body.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x and y required');

  const chunkKey = getChunkKey(x, y);
  const tileKey  = `${x},${y}`;
  const chunk = await db.collection('chunks').findOne(
    { worldId, chunkKey },
    { projection: { [`tiles.${tileKey}.structure`]: 1 } }
  );
  const structure = chunk?.tiles?.[tileKey]?.structure;
  if (!structure)        throw new Error('no structure on this tile');
  if (!structure.owner || structure.monster) throw new Error('only player-held structures hold elections');
  if (structure.type === 'ruins' || structure.status === 'building') {
    throw new Error('this structure cannot hold an election');
  }

  const open = await db.collection('elections').findOne({ worldId, chunkKey, tileKey, status: 'open' });
  if (open) throw new Error('an election is already under way here');

  const recent = await db.collection('elections').findOne(
    { worldId, chunkKey, tileKey, status: 'closed', closedAt: { $gte: new Date(Date.now() - ELECTION_COOLDOWN_MS) } }
  );
  if (recent) throw new Error('an election was held here recently — wait before calling another');

  const now = new Date();
  const doc = {
    worldId,
    chunkKey,
    tileKey,
    location: { x, y },
    structureName: structure.name || structure.type,
    incumbentUid: structure.owner,
    calledBy: uid,
    candidates: {},
    tallies: {},
    voters: {},
    openedAt: now,
    closesAt: new Date(now.getTime() + ELECTION_DURATION_MS),
    status: 'open',
  };
  const r = await db.collection('elections').insertOne(doc);
  return { _id: r.insertedId, ...doc };
}

export async function castElectionVote(db, electionId, uid, candidateUid) {
  const _id = new ObjectId(electionId);
  const doc = await db.collection('elections').findOne({ _id });
  if (!doc || doc.status !== 'open') return null;
  if (!candidateUid) throw new Error('candidateUid required');

  // Voting for someone nominates them; resolve their display name lazily.
  let candidateName = doc.candidates?.[candidateUid];
  if (!candidateName) {
    const p = await db.collection('players').findOne(
      { _id: candidateUid },
      { projection: { [`worlds.${doc.worldId}.displayName`]: 1 } }
    );
    candidateName = p?.worlds?.[doc.worldId]?.displayName || 'Unknown';
  }

  const prev = doc.voters?.[uid];
  const $inc = { [`tallies.${candidateUid}`]: 1 };
  const $set = {
    [`voters.${uid}`]: candidateUid,
    [`candidates.${candidateUid}`]: candidateName,
  };
  if (prev && prev !== candidateUid) $inc[`tallies.${prev}`] = -1;

  const r = await db.collection('elections').findOneAndUpdate(
    { _id }, { $inc, $set }, { returnDocument: 'after' }
  );
  return r.value || r;
}

/**
 * Tick: close due elections and seat the winners. The candidate with the most
 * votes takes stewardship of the structure; ties (or no votes) keep the
 * incumbent. Returns the number of elections closed.
 */
export async function tickElections(db, worldId, now = new Date()) {
  const closing = await db.collection('elections')
    .find({ worldId, status: 'open', closesAt: { $lte: now } })
    .toArray();
  if (!closing.length) return 0;

  const { Ops } = await import('../lib/ops.js');

  for (const e of closing) {
    const tallies = Object.entries(e.tallies || {}).filter(([, n]) => n > 0);
    tallies.sort((a, b) => b[1] - a[1]);
    const top = tallies[0];
    const tied = top && tallies[1] && tallies[1][1] === top[1];
    const winnerUid = top && !tied ? top[0] : e.incumbentUid;
    const winnerName = e.candidates?.[winnerUid] || null;
    const outcome = winnerUid === e.incumbentUid ? 'incumbent_holds' : 'unseated';

    if (outcome === 'unseated') {
      const ops = new Ops();
      ops.chunk(e.worldId, e.chunkKey, `${e.tileKey}.structure.owner`, winnerUid);
      ops.chunk(e.worldId, e.chunkKey, `${e.tileKey}.structure.ownerName`, winnerName);
      ops.chat(e.worldId, {
        text: `The people have spoken — ${winnerName || 'a new steward'} now governs ${e.structureName} at (${e.location.x}, ${e.location.y}).`,
        type: 'event', timestamp: now.getTime(), location: e.location,
      });
      ops.report(e.incumbentUid, e.worldId, {
        type: 'election_lost',
        title: `Unseated at ${e.structureName}`,
        summary: `You lost the election at ${e.structureName} (${e.location.x}, ${e.location.y}) to ${winnerName || 'a rival'}.`,
        location: e.location,
      });
      ops.report(winnerUid, e.worldId, {
        type: 'election_won',
        title: `Elected at ${e.structureName}`,
        summary: `You won the election at ${e.structureName} (${e.location.x}, ${e.location.y}) and now govern it.`,
        location: e.location,
      });
      await ops.flush(db);
    } else {
      const ops = new Ops();
      ops.chat(e.worldId, {
        text: `The election at ${e.structureName} (${e.location.x}, ${e.location.y}) concludes — the incumbent steward holds power.`,
        type: 'event', timestamp: now.getTime(), location: e.location,
      });
      await ops.flush(db);
    }

    await db.collection('elections').updateOne(
      { _id: e._id },
      { $set: { status: 'closed', closedAt: now, winnerUid, outcome } }
    );
  }
  return closing.length;
}
