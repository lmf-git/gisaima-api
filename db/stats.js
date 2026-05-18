/**
 * Player stats — XP, levels, distance, kills/deaths/wins/losses, gold,
 * privacy flag (hideWealth), morality snapshot, cosmetics.
 *
 * `addXp` is called from battle / gathering / building outcomes via tick hooks.
 * `addDistance` is called by moveTick when a unit group successfully completes
 * a hop. `recordKill`/`recordDeath` are called by battleTick.
 */

const XP_PER_LEVEL = 25;

export function levelFromXp(xp) {
  return Math.floor(Math.sqrt(Math.max(0, xp) / XP_PER_LEVEL)) + 1;
}

export function xpForNextLevel(level) {
  return Math.pow(level, 2) * XP_PER_LEVEL;
}

export async function getFor(db, worldId, uid) {
  const r = await db.collection('players').findOne(
    { _id: uid },
    { projection: { [`worlds.${worldId}`]: 1 } }
  );
  const w = r?.worlds?.[worldId] || {};
  const xp = w.xp || 0;
  const level = w.level || levelFromXp(xp);
  return {
    xp,
    level,
    nextLevelAt: xpForNextLevel(level),
    distance: w.distance || 0,
    kills: w.kills || 0,
    deaths: w.deaths || 0,
    wins: w.battlesWon || 0,
    losses: w.battlesLost || 0,
    gold: w.gold || 0,
    alive: w.alive !== false,
    hideWealth: !!w.hideWealth,
    morality: w.morality || { good: 0, evil: 0, score: 0 },
    cosmetics: w.cosmetics || [],
    equipped: w.equipped || {},
    displayName: w.displayName || null
  };
}

export async function setFlag(db, worldId, uid, field, value) {
  if (!['hideWealth', 'displayName'].includes(field)) throw new Error('unknown field');
  await db.collection('players').updateOne(
    { _id: uid },
    { $set: { [`worlds.${worldId}.${field}`]: value } },
    { upsert: true }
  );
}

export async function addXp(db, worldId, uid, amount) {
  if (!uid || !Number.isFinite(amount) || amount === 0) return null;
  const r = await db.collection('players').findOneAndUpdate(
    { _id: uid },
    { $inc: { [`worlds.${worldId}.xp`]: amount } },
    { upsert: true, returnDocument: 'after' }
  );
  const doc = r.value || r;
  const xp = doc?.worlds?.[worldId]?.xp || 0;
  const lvl = levelFromXp(xp);
  if (lvl !== (doc?.worlds?.[worldId]?.level)) {
    await db.collection('players').updateOne(
      { _id: uid },
      { $set: { [`worlds.${worldId}.level`]: lvl } }
    );
  }
  return { xp, level: lvl };
}

export async function addDistance(db, worldId, uid, tiles = 1) {
  if (!uid || tiles <= 0) return;
  await db.collection('players').updateOne(
    { _id: uid },
    { $inc: { [`worlds.${worldId}.distance`]: tiles } },
    { upsert: true }
  );
}

export async function recordKill(db, worldId, uid) {
  await db.collection('players').updateOne(
    { _id: uid },
    { $inc: { [`worlds.${worldId}.kills`]: 1 } },
    { upsert: true }
  );
  await addXp(db, worldId, uid, 25);
}

export async function recordDeath(db, worldId, uid) {
  await db.collection('players').updateOne(
    { _id: uid },
    { $inc: { [`worlds.${worldId}.deaths`]: 1 } },
    { upsert: true }
  );
}

export async function recordBattle(db, worldId, uid, won) {
  const field = won ? 'battlesWon' : 'battlesLost';
  await db.collection('players').updateOne(
    { _id: uid },
    { $inc: { [`worlds.${worldId}.${field}`]: 1 } },
    { upsert: true }
  );
  if (won) await addXp(db, worldId, uid, 10);
}

/**
 * Wealth rankings — summed from every structure / group the player owns
 * (gold is the `GOLD` item key inside structure.items / group.items).
 * Respects the `hideWealth` privacy flag.
 *
 * There is no global player wallet, so we walk chunks once per call.
 * For a busy world this is O(chunks × tiles); cache externally if needed.
 */
export async function wealthRankings(db, worldId, limit = 50) {
  const [players, chunks] = await Promise.all([
    db.collection('players')
      .find(
        { [`worlds.${worldId}`]: { $exists: true } },
        { projection: { _id: 1, [`worlds.${worldId}.displayName`]: 1, [`worlds.${worldId}.hideWealth`]: 1 } }
      ).toArray(),
    db.collection('chunks').find({ worldId }, { projection: { tiles: 1 } }).toArray()
  ]);

  const totals = {};
  for (const chunk of chunks) {
    for (const tile of Object.values(chunk.tiles || {})) {
      if (tile.structure?.owner && tile.structure.items?.GOLD) {
        totals[tile.structure.owner] = (totals[tile.structure.owner] || 0) + Number(tile.structure.items.GOLD || 0);
      }
      for (const group of Object.values(tile.groups || {})) {
        if (group?.owner && group?.items?.GOLD) {
          totals[group.owner] = (totals[group.owner] || 0) + Number(group.items.GOLD || 0);
        }
      }
    }
  }

  return players
    .filter((p) => !p.worlds?.[worldId]?.hideWealth)
    .map((p) => ({
      uid: p._id,
      displayName: p.worlds?.[worldId]?.displayName || 'Unknown',
      gold: totals[p._id] || 0
    }))
    .sort((a, b) => b.gold - a.gold)
    .slice(0, limit);
}
