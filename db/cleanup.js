/**
 * Inactivity & decay — keep the realm tidy without breaking live state.
 *
 * Rules:
 *   - Every authed request bumps `players.worlds.<worldId>.lastSeen` (set
 *     centrally in routes/router.js).
 *   - Each world tick, this module:
 *       1. Computes per-player days-since-lastSeen for that world.
 *       2. Degrades structures whose owner is "inactive" (>7 in-game days
 *          quiet) by a small durability hit per tick. Structures whose
 *          owner is "purgeable" (>30 days) get a heavier hit.
 *       3. Promotes structures whose durability reaches 0 to `ruin` status
 *          (kept on the map, no longer functional; items remain droppable).
 *       4. Marks groups & structures of "purgeable" players for removal,
 *          but never removes anything that is currently:
 *            - involved in a tile-level battle  (tile.battles present)
 *            - flagged as besieged or part of an ongoing conquer
 *            - flagged with `pendingBattleFromUid`
 *          Such items stay on the map until the battle resolves, then a
 *          subsequent cleanup tick can collect them.
 *       5. Removes the player document itself only after their owned
 *          groups & structures are gone (their lives chronicle stays —
 *          the realm remembers).
 *
 * Tunable thresholds are constants below; tweak per world via worldInfo
 * overrides in a future pass.
 */

const TICKS_PER_GAME_DAY     = 24;     // tick == 1 in-realm hour (per design doc)
const INACTIVE_AFTER_DAYS    = 7;      // owner is "quiet"
const PURGE_AFTER_DAYS       = 30;     // owner's assets become removable
const DELETE_PLAYER_AFTER_DAYS = 60;   // player doc itself

const STRUCTURE_DECAY_INACTIVE = 1;    // durability lost / tick when quiet
const STRUCTURE_DECAY_PURGE    = 3;    // durability lost / tick when purgeable
const GROUP_DECAY_INACTIVE     = 0;    // groups don't decay — they just become collectible
const RUIN_STATUS              = 'ruin';

function _ticksToDays(ticks) { return ticks / TICKS_PER_GAME_DAY; }

/**
 * Convert real-time elapsed since lastSeen into in-realm game days, using
 * the world's own tick cadence + speed. A "game day" is `TICKS_PER_GAME_DAY`
 * (24) ticks; one tick = `tickInterval` ms of real time, divided by `speed`
 * (higher speed = ticks happen more often).
 */
function _daysSinceLastSeen(player, worldId, worldInfo, now = Date.now()) {
  const ts = player?.worlds?.[worldId]?.lastSeen;
  if (!ts) return null;
  const t = typeof ts === 'number' ? ts : new Date(ts).getTime();
  if (!Number.isFinite(t)) return null;

  const tickIntervalMs = Number(worldInfo?.tickInterval ?? worldInfo?.tickMs ?? 60_000);
  const speed = Math.max(0.01, Number(worldInfo?.speed) || 1);
  const effectiveTickMs = tickIntervalMs / speed;
  const ticksElapsed = (now - t) / effectiveTickMs;
  return _ticksToDays(ticksElapsed);
}

function _isProtected(tile, group) {
  if (tile?.battles && Object.keys(tile.battles).length > 0) return true;
  if (group?.battleId) return true;
  if (group?.status === 'fighting') return true;
  if (group?.pendingBattleFromUid) return true;
  return false;
}

function _isStructureProtected(tile, structure) {
  if (tile?.battles && Object.keys(tile.battles).length > 0) return true;
  if (structure?.besieged) return true;
  if (structure?.conqueredAt && !structure?.conquerResolvedAt) return true;
  return false;
}

/**
 * Run one cleanup pass for a world. Must execute *after* battleTick has
 * resolved (so any pending battles for a soon-to-be-purged player are
 * already reflected in tile.battles).
 *
 * Returns counts: { degraded, ruined, removedGroups, removedStructures, removedPlayers }
 */
export async function tick(db, worldId, chunks, ops, worldInfo = null) {
  const out = { degraded: 0, ruined: 0, removedGroups: 0, removedStructures: 0, removedPlayers: 0 };

  // Per-world threshold overrides — let admins re-tune without code change.
  const wInactive = Number(worldInfo?.cleanup?.inactiveAfterDays  ?? INACTIVE_AFTER_DAYS);
  const wPurge    = Number(worldInfo?.cleanup?.purgeAfterDays     ?? PURGE_AFTER_DAYS);
  const wDelete   = Number(worldInfo?.cleanup?.deletePlayerAfterDays ?? DELETE_PLAYER_AFTER_DAYS);

  // 1) Pull every player in this world and bucket by activity.
  const players = await db.collection('players').find(
    { [`worlds.${worldId}`]: { $exists: true } },
    { projection: { _id: 1, [`worlds.${worldId}.lastSeen`]: 1, [`worlds.${worldId}.alive`]: 1 } }
  ).toArray();

  const activityByUid = new Map();
  const now = Date.now();
  for (const p of players) {
    const days = _daysSinceLastSeen(p, worldId, worldInfo, now);
    let bucket = 'active';
    if (days != null) {
      if (days >= wDelete)   bucket = 'delete';
      else if (days >= wPurge)    bucket = 'purge';
      else if (days >= wInactive) bucket = 'inactive';
    }
    activityByUid.set(p._id, { bucket, days });
  }

  // 2) Walk every tile of every chunk. The `chunks` map is the one tick.js
  // already loaded — passing it through avoids a re-fetch.
  for (const [chunkKey, tiles] of Object.entries(chunks || {})) {
    for (const [tileKey, tile] of Object.entries(tiles || {})) {
      if (!tile) continue;

      // ── Structures ──
      if (tile.structure?.owner && tile.structure.owner !== 'monster') {
        const uid = tile.structure.owner;
        const act = activityByUid.get(uid);
        if (act && act.bucket !== 'active' && !_isStructureProtected(tile, tile.structure)) {
          const decay = act.bucket === 'inactive'
            ? STRUCTURE_DECAY_INACTIVE
            : STRUCTURE_DECAY_PURGE;
          const before = tile.structure.durability ?? tile.structure.durabilityMax ?? 100;
          const after = Math.max(0, before - decay);

          if (after === 0 && tile.structure.status !== RUIN_STATUS) {
            // Promote to ruin — no owner action, items remain on tile, status switches.
            ops.chunk(worldId, chunkKey, `${tileKey}.structure.status`,    RUIN_STATUS);
            ops.chunk(worldId, chunkKey, `${tileKey}.structure.durability`, 0);
            ops.chunk(worldId, chunkKey, `${tileKey}.structure.ruinedAt`,  new Date());
            out.ruined++;
          } else if (after !== before) {
            ops.chunk(worldId, chunkKey, `${tileKey}.structure.durability`, after);
            out.degraded++;
          }

          // Heavy purge: structure is unowned entirely after PURGE threshold.
          // We do *not* delete the structure (other players may have invested
          // there) — we strip ownership so it becomes a neutral landmark.
          if (act.bucket === 'purge' && tile.structure.owner) {
            ops.chunk(worldId, chunkKey, `${tileKey}.structure.owner`,    null);
            ops.chunk(worldId, chunkKey, `${tileKey}.structure.abandoned`, true);
            ops.chunk(worldId, chunkKey, `${tileKey}.structure.abandonedAt`, new Date());
            out.removedStructures++;
          }
        }
      }

      // ── Groups ──
      if (tile.groups) {
        for (const [gid, group] of Object.entries(tile.groups)) {
          if (!group || group.type === 'monster' || !group.owner) continue;
          const act = activityByUid.get(group.owner);
          if (!act || act.bucket === 'active') continue;
          if (_isProtected(tile, group)) continue;

          if (act.bucket === 'purge' || act.bucket === 'delete') {
            // Drop the group's items onto the tile as a scavengeable drop so
            // nothing is lost from the world economy.
            if (group.items && Object.keys(group.items).length) {
              const [x, y] = tileKey.split(',').map(Number);
              db.collection('item_drops').insertOne({
                worldId, x, y, items: group.items,
                droppedAt: new Date(),
                from: group.owner,
                reason: 'cleanup'
              }).catch(() => {});
            }
            ops.chunk(worldId, chunkKey, `${tileKey}.groups.${gid}`, null);
            out.removedGroups++;
          }
        }
      }
    }
  }

  // 3) Final pass — players who are 'delete' bucket AND no longer own any
  // structures/groups can have their world record removed. Their `lives`
  // chronicle is preserved (historical record).
  for (const [uid, act] of activityByUid) {
    if (act.bucket !== 'delete') continue;
    const stillOwnsSomething = await _ownsAnything(db, worldId, uid);
    if (stillOwnsSomething) continue;
    await db.collection('players').updateOne(
      { _id: uid },
      { $unset: { [`worlds.${worldId}`]: '' } }
    );
    out.removedPlayers++;
  }

  return out;
}

async function _ownsAnything(db, worldId, uid) {
  // Quick scan of chunks for any structure / group owned by uid.
  const cursor = db.collection('chunks').find({ worldId }, { projection: { tiles: 1 } });
  for await (const chunk of cursor) {
    for (const tile of Object.values(chunk.tiles || {})) {
      if (tile.structure?.owner === uid) return true;
      for (const g of Object.values(tile.groups || {})) {
        if (g?.owner === uid) return true;
      }
    }
  }
  return false;
}

/**
 * Centralised lastSeen bumper — call from router.js whenever the request
 * carries auth, fire-and-forget.
 */
export async function touchLastSeen(db, uid, worldId) {
  if (!uid || !worldId) return;
  try {
    await db.collection('players').updateOne(
      { _id: uid, [`worlds.${worldId}`]: { $exists: true } },
      { $set: { [`worlds.${worldId}.lastSeen`]: new Date() } }
    );
  } catch {
    /* swallow — best effort */
  }
}
