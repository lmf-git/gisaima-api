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

/**
 * Tick: closes any open votes whose `closesAt` has passed, finalising tallies.
 * Returns the number of votes closed in this pass.
 */
export async function tickClosure(db, worldId, now = new Date()) {
  const r = await db.collection('votes').updateMany(
    { worldId, status: 'open', closesAt: { $ne: null, $lte: now } },
    { $set: { status: 'closed', closedAt: now } }
  );
  return r.modifiedCount || 0;
}
