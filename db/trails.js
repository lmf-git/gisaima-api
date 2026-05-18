/**
 * Treasure Trails — chained clue waypoints. Owner walks the realm visiting
 * each tile; when present (within `proximity` tiles) the step auto-solves.
 *
 * Two generators:
 *   - `anagram` — clue is a scrambled anagram of (player name + village name)
 *   - `spawn`   — radiates outward from the player's spawn structure
 *
 * Steps are checked from the player's last-known location on tick (see
 * `progressTrails`). Real-time progress is also possible via the explicit
 * solve endpoint for testing.
 */
import { ObjectId } from 'mongodb';

const STEP_COUNT = 4;
const PROXIMITY = 2;

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

function buildAnagramSteps(seedString, originX = 0, originY = 0) {
  const base = (seedString || 'realm').toUpperCase().replace(/[^A-Z]/g, '');
  const steps = [];
  for (let i = 0; i < STEP_COUNT; i++) {
    const h = hashStr(seedString + ':' + i);
    const ang = (h % 360) * (Math.PI / 180);
    const radius = 6 + ((h >> 8) % 14) * (i + 1);
    const x = Math.round(originX + Math.cos(ang) * radius);
    const y = Math.round(originY + Math.sin(ang) * radius);
    const scrambled = [...base].sort(() => (((h >> (i + 1)) & 1) ? 1 : -1)).join('').slice(0, 9);
    steps.push({ x, y, clue: `Letters whisper: ${scrambled}`, solved: false });
  }
  return steps;
}

function buildSpawnSteps(originX, originY, seedString = 'spawn') {
  const steps = [];
  for (let i = 0; i < STEP_COUNT; i++) {
    const h = hashStr(seedString + ':' + i);
    const ang = (h % 360) * (Math.PI / 180);
    const r = 4 + (i * 4);
    steps.push({
      x: Math.round(originX + Math.cos(ang) * r),
      y: Math.round(originY + Math.sin(ang) * r),
      clue: `A bearing of ${Math.round(ang * 180 / Math.PI)}° from the rim, ${r} paces.`,
      solved: false
    });
  }
  return steps;
}

export async function create(db, { worldId, ownerUid, kind = 'anagram', seedString, originX = 0, originY = 0, rewardItem = 'MYSTERIOUS_ARTIFACT' }) {
  const steps = kind === 'spawn'
    ? buildSpawnSteps(originX, originY, seedString || ownerUid)
    : buildAnagramSteps(seedString || ownerUid, originX, originY);

  const insert = {
    worldId, ownerUid, kind, rewardItem, steps,
    originX, originY,
    status: 'open',
    createdAt: new Date()
  };
  const r = await db.collection('trails').insertOne(insert);
  return { ...insert, _id: r.insertedId };
}

export async function listFor(db, worldId, uid) {
  return db.collection('trails')
    .find({ worldId, ownerUid: uid })
    .sort({ createdAt: -1 })
    .toArray();
}

async function awardReward(db, worldId, uid, item) {
  await db.collection('players').updateOne(
    { _id: uid },
    { $inc: { [`worlds.${worldId}.rewards.${item}`]: 1 } },
    { upsert: true }
  );
}

export async function solveStep(db, trailId, stepIndex) {
  const _id = new ObjectId(trailId);
  const doc = await db.collection('trails').findOne({ _id });
  if (!doc || doc.status !== 'open') return null;
  if (!doc.steps?.[stepIndex]) return doc;

  doc.steps[stepIndex].solved = true;
  const allSolved = doc.steps.every((s) => s.solved);
  await db.collection('trails').updateOne(
    { _id },
    { $set: { steps: doc.steps, status: allSolved ? 'completed' : 'open' } }
  );
  if (allSolved) await awardReward(db, doc.worldId, doc.ownerUid, doc.rewardItem);
  return { ...doc, status: allSolved ? 'completed' : 'open' };
}

/**
 * Tick-driven progress: for each open trail in a world, advance the first
 * unsolved step if the owner is within PROXIMITY tiles. Returns the number
 * of trails completed this pass.
 */
export async function progressTrails(db, worldId) {
  const open = await db.collection('trails').find({ worldId, status: 'open' }).toArray();
  if (!open.length) return 0;

  // Pull last-known locations for every owner in one query.
  const ownerUids = [...new Set(open.map((t) => t.ownerUid))];
  const players = await db.collection('players').find(
    { _id: { $in: ownerUids } },
    { projection: { _id: 1, [`worlds.${worldId}.lastLocation`]: 1, [`worlds.${worldId}.location`]: 1 } }
  ).toArray();
  const locByUid = Object.fromEntries(players.map((p) => [
    p._id,
    p.worlds?.[worldId]?.lastLocation || p.worlds?.[worldId]?.location || null
  ]));

  let completed = 0;
  for (const t of open) {
    const loc = locByUid[t.ownerUid];
    if (!loc) continue;
    const next = t.steps.findIndex((s) => !s.solved);
    if (next === -1) continue;
    const step = t.steps[next];
    if (Math.hypot((loc.x ?? 0) - step.x, (loc.y ?? 0) - step.y) <= PROXIMITY) {
      const out = await solveStep(db, t._id.toString(), next);
      if (out?.status === 'completed') completed++;
    }
  }
  return completed;
}
