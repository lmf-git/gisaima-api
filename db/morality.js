/**
 * Morality — players accuse each other of good/evil deeds, optionally
 * pointing at a report (justification). Daily allowance per accuser.
 * Score is stored on `players.worlds.<worldId>.morality.score`.
 *
 * Driven by:
 *   - Direct player accusations via /worlds/:id/morality
 *   - Battle outcomes: kills inside an exclusion zone (spawn) auto-deduct,
 *     killing a player whose score is < -10 ("evil") auto-adds. See
 *     morality.applyKillEffect — invoked from battleTick.
 */
import { isInsideExclusion } from './spawns.js';
import { createBounty, getBountiesOnTarget } from './bounties.js';

export const MORALITY_POINTS_PER_DAY = 5;
export const EVIL_THRESHOLD = -10;
export const SAINT_THRESHOLD = 10;
// A realm-funded bounty placed on a player who turns evil, drawn from the world
// bounty pool (seeded by governance "bounty" votes). Capped per posting.
const AUTO_BOUNTY_MAX = 50;

function dayBucket(d = new Date()) {
  return Math.floor(d.getTime() / (1000 * 60 * 60 * 24));
}

export async function listScores(db, worldId, limit = 50) {
  const rows = await db.collection('players')
    .find({ [`worlds.${worldId}`]: { $exists: true } },
           { projection: { _id: 1, [`worlds.${worldId}.displayName`]: 1, [`worlds.${worldId}.morality`]: 1 } })
    .toArray();
  return rows
    .map((r) => ({
      uid: r._id,
      displayName: r.worlds?.[worldId]?.displayName || 'Unknown',
      score: r.worlds?.[worldId]?.morality?.score ?? 0,
      good:  r.worlds?.[worldId]?.morality?.good  ?? 0,
      evil:  r.worlds?.[worldId]?.morality?.evil  ?? 0
    }))
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, limit);
}

// Combat morale from standing: saints fight inspired, villains are reviled and
// fight at a discount. Returns a multiplier applied to group power in battle.
export const SAINT_COMBAT_BONUS = 0.05;
export const VILLAIN_COMBAT_PENALTY = 0.05;
export function moralityCombatFactor(score) {
  const s = Number(score) || 0;
  if (s >= SAINT_THRESHOLD) return 1 + SAINT_COMBAT_BONUS;
  if (s <= EVIL_THRESHOLD)  return 1 - VILLAIN_COMBAT_PENALTY;
  return 1;
}

// Trade standing: a villain's caravans are preyed upon (higher ambush risk),
// a saint's are sheltered by a grateful populace (lower). Neutral = base.
export function moralityAmbushChance(score, base = 0.1) {
  const s = Number(score) || 0;
  if (s <= EVIL_THRESHOLD)  return Math.min(0.9, base * 2);
  if (s >= SAINT_THRESHOLD) return base / 2;
  return base;
}

// Morality scores for a set of uids in one query → { uid: score }.
export async function scoresFor(db, worldId, uids = []) {
  const ids = [...new Set(uids.filter(Boolean))];
  if (!ids.length) return {};
  const rows = await db.collection('players')
    .find({ _id: { $in: ids } }, { projection: { [`worlds.${worldId}.morality.score`]: 1 } })
    .toArray();
  const out = {};
  for (const r of rows) out[r._id] = r.worlds?.[worldId]?.morality?.score ?? 0;
  return out;
}

export async function getFor(db, worldId, uid) {
  const r = await db.collection('players').findOne(
    { _id: uid },
    { projection: { [`worlds.${worldId}.morality`]: 1 } }
  );
  return r?.worlds?.[worldId]?.morality || { good: 0, evil: 0, score: 0 };
}

async function applyDelta(db, worldId, uid, polarity, magnitude = 1) {
  const sign = polarity === 'good' ? 1 : -1;
  await db.collection('players').updateOne(
    { _id: uid },
    {
      $inc: {
        [`worlds.${worldId}.morality.${polarity}`]: magnitude,
        [`worlds.${worldId}.morality.score`]: sign * magnitude
      }
    },
    { upsert: true }
  );
  // Turning evil puts a price on your head, paid from the realm bounty pool.
  if (polarity === 'evil') await maybeAutoBountyEvil(db, worldId, uid);
}

/**
 * If `uid` is now evil and has no standing realm bounty, post one funded from
 * the world bounty pool (governance "bounty" votes seed `info.bountyPool`).
 * Existing player-posted bounties are settled by the normal kill path.
 */
async function maybeAutoBountyEvil(db, worldId, uid) {
  try {
    const score = (await getFor(db, worldId, uid)).score;
    if (score > EVIL_THRESHOLD) return;

    const existing = await getBountiesOnTarget(db, worldId, uid);
    if (existing.some(b => b.postedBy === 'realm')) return;

    // Draw from the world bounty pool without overdrawing it.
    const world = await db.collection('worlds').findOne(
      { _id: worldId }, { projection: { 'info.bountyPool': 1 } });
    const pool = Number(world?.info?.bountyPool) || 0;
    if (pool <= 0) return;
    const amount = Math.min(AUTO_BOUNTY_MAX, pool);

    const r = await db.collection('worlds').updateOne(
      { _id: worldId, 'info.bountyPool': { $gte: amount } },
      { $inc: { 'info.bountyPool': -amount } });
    if (r.modifiedCount === 0) return; // pool changed under us

    const target = await db.collection('players').findOne(
      { _id: uid }, { projection: { [`worlds.${worldId}.displayName`]: 1 } });
    await createBounty(db, {
      worldId, targetUid: uid,
      targetName: target?.worlds?.[worldId]?.displayName || 'A villain',
      amount, postedBy: 'realm', postedByName: 'The Realm',
    });
  } catch (err) {
    console.error(`[morality] auto-bounty ${worldId}/${uid}:`, err);
  }
}

export async function accuse(db, worldId, accuserUid, targetUid, polarity, reportRef, comment) {
  if (accuserUid === targetUid) throw new Error('cannot accuse yourself');
  if (polarity !== 'good' && polarity !== 'evil') throw new Error('polarity must be good or evil');

  const today = dayBucket();
  const used = await db.collection('morality_accusations').countDocuments({
    accuserUid, worldId, day: today
  });
  if (used >= MORALITY_POINTS_PER_DAY) throw new Error('daily morality points exhausted');

  await db.collection('morality_accusations').insertOne({
    worldId, accuserUid, targetUid, polarity,
    reportRef: reportRef || null, comment: comment || '',
    createdAt: new Date(), day: today
  });

  await applyDelta(db, worldId, targetUid, polarity, 1);
  return { ok: true, score: (await getFor(db, worldId, targetUid)).score };
}

export async function history(db, worldId, uid, limit = 50) {
  const [good, evil] = await Promise.all([
    db.collection('morality_accusations')
      .find({ worldId, targetUid: uid, polarity: 'good' })
      .sort({ createdAt: -1 }).limit(limit).toArray(),
    db.collection('morality_accusations')
      .find({ worldId, targetUid: uid, polarity: 'evil' })
      .sort({ createdAt: -1 }).limit(limit).toArray()
  ]);
  return { good, evil };
}

/**
 * Real morality effect from a battle kill. Wired into battleTick.
 *
 *  - killing inside the spawn exclusion zone of the victim → −3 evil
 *  - killing a player whose score ≤ EVIL_THRESHOLD → +2 good
 *  - killing a player whose score ≥ SAINT_THRESHOLD → −2 evil (slaying a saint)
 *  - otherwise no automatic effect
 */
export async function applyKillEffect(db, worldId, killerUid, victimUid, location) {
  if (!killerUid || !victimUid) return null;

  const victimScore = (await getFor(db, worldId, victimUid)).score;

  let polarity = null;
  let magnitude = 0;

  if (location && await isInsideExclusion(db, worldId, location.x, location.y, victimUid)) {
    polarity = 'evil';
    magnitude = 3;
  } else if (victimScore <= EVIL_THRESHOLD) {
    polarity = 'good';
    magnitude = 2;
  } else if (victimScore >= SAINT_THRESHOLD) {
    polarity = 'evil';
    magnitude = 2;
  }

  if (polarity) {
    await applyDelta(db, worldId, killerUid, polarity, magnitude);
    return { polarity, magnitude };
  }
  return null;
}
