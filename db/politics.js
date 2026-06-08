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

  const durationMs = clampDuration(body.durationMs);
  const now = new Date();
  const doc = {
    worldId,
    title,
    description: (body.description || '').toString().slice(0, 500),
    proposedBy: uid,
    kind,
    cost,
    params: body.params && typeof body.params === 'object' ? body.params : {},
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
    // Spent gold seeds a monster-slaying bounty pool claimed during play.
    await db.collection('worlds').updateOne(
      { _id: worldId }, { $inc: { 'info.bountyPool': vote.cost?.gold || 0 } }, { upsert: true });
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
