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

export const MORALITY_POINTS_PER_DAY = 5;
export const EVIL_THRESHOLD = -10;
export const SAINT_THRESHOLD = 10;

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
