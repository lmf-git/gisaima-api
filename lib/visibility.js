/**
 * Fog of war — server-side visibility filtering.
 *
 * Visibility is the union of circular sight areas around every group and
 * structure owned by a player.  Default radii:
 *   player    : 7 tiles
 *   groups    : 5 tiles  (or group.sightRange if set)
 *   structures: 2 tiles  (watchtower=5, outpost=7, spawn=5, or structure.sightRange)
 *
 * Two extensions land here on top of the basic sight model:
 *
 *  - **Tiered scouting** — every scout has up to 3 informational tiers visible
 *    around them. Inner tier reveals identity & loadout, mid tier reveals what
 *    a group is, outer tier reveals only "something is there". The outer
 *    tiers are still stored as visible tiles, but the broadcast/filter layer
 *    can downgrade them via `filterTilesForPlayer({ tier:'something' })`.
 *
 *  - **Morality beacon** — players with a low morality score are easier to
 *    spot. Every active group and structure they own is broadcast as visible
 *    to ALL players within a beaconRadius driven by how negative their
 *    morality is. This expresses the "bad actions lead to more visibility"
 *    line from the design doc.
 *
 * The cache is rebuilt once per world tick and queried during chunk broadcasts
 * and HTTP chunk requests.
 */

import { geneticMod } from 'gisaima-shared/lives/genetics.js';
import { isNight } from 'gisaima-shared/time/era.js';

const DEFAULT_GROUP_SIGHT     = 5;
const DEFAULT_STRUCTURE_SIGHT = 2;
const DEFAULT_PLAYER_SIGHT    = 7;
const STRUCTURE_SIGHT_OVERRIDES = { watchtower: 5, outpost: 7, spawn: 5 };
// Vision contracts at night (see era.js). Floored so nothing goes blind.
const NIGHT_SIGHT_PENALTY = 2;
const MIN_SIGHT = 1;

// Beacon radii — tiles around a hostile/evil player's groups & structures
// that are made visible to *everyone*. Scales with how evil the score is.
function _beaconRadius(score) {
  if (score == null) return 0;
  if (score >= 0) return 0;
  // -1..-5 → 1, -6..-15 → 2, -16..-30 → 3, lower → 4
  const a = Math.abs(score);
  if (a <= 5)  return 1;
  if (a <= 15) return 2;
  if (a <= 30) return 3;
  return 4;
}

// Cache: Map<worldId, Map<userId, Set<"x,y">>>
const _cache = new Map();
// Beacon: Set<"x,y"> per world — visible to everyone.
const _beaconCache = new Map();
// Map<worldId, timestamp ms> — when each world's cache was last rebuilt.
const _builtAt = new Map();
// Map<worldId, Promise> — coalesces concurrent rebuilds for the same world.
const _refreshing = new Map();

function _addCircle(set, cx, cy, range) {
  const r2 = range * range;
  for (let dx = -range; dx <= range; dx++) {
    for (let dy = -range; dy <= range; dy++) {
      if (dx * dx + dy * dy <= r2) set.add(`${cx + dx},${cy + dy}`);
    }
  }
}

/**
 * Rebuild the per-player visibility cache for a world.
 * chunks: { [chunkKey]: { [tileKey]: tileData } }
 * moralityByUid: optional map of { uid → score } used to compute beacons.
 */
export function updateWorldVisibility(worldId, chunks, moralityByUid = null, tickCount = 0) {
  const worldMap = new Map();  // userId → Set<"x,y">
  const beacon   = new Set();  // visible-to-all set

  // Mobile sight (groups, players) contracts at night; structures keep their
  // braziers lit and see as normal. Floored so nothing is fully blinded.
  const night = isNight(tickCount);
  const nightAdjust = (range) => night ? Math.max(MIN_SIGHT, range - NIGHT_SIGHT_PENALTY) : range;

  for (const tiles of Object.values(chunks)) {
    for (const [tileKey, tile] of Object.entries(tiles)) {
      if (!tile) continue;
      const [x, y] = tileKey.split(',').map(Number);

      if (tile.groups) {
        for (const group of Object.values(tile.groups)) {
          if (!group || group.type === 'monster' || !group.owner) continue;
          const uid = group.owner;
          if (!worldMap.has(uid)) worldMap.set(uid, new Set());

          // A group sees as far as its best-sighted unit. A player character
          // riding inside the group keeps their personal sight (7, +genetics),
          // which outranges the group default (5). Without this, mobilising in
          // place shrinks the player's view from 7 to 5, blinking fog-gated
          // items out of the ring 6–7 that the client (which reveals
          // player-sight around the group via currentPlayerPosition) still
          // shows as un-fogged.
          let sight = group.sightRange ?? DEFAULT_GROUP_SIGHT;
          if (group.units) {
            for (const u of Object.values(group.units)) {
              const unitSight = u?.type === 'player'
                ? DEFAULT_PLAYER_SIGHT + geneticMod(u, 'sight')
                : (u?.sightRange ?? u?.sight ?? DEFAULT_GROUP_SIGHT);
              if (unitSight > sight) sight = unitSight;
            }
          }
          _addCircle(worldMap.get(uid), x, y, nightAdjust(sight));

          // Morality beacon: evil players radiate visibility for everyone.
          const score = moralityByUid?.[uid];
          const beaconR = _beaconRadius(score);
          if (beaconR > 0) _addCircle(beacon, x, y, beaconR);
        }
      }

      if (tile.players) {
        // Entities are keyed by lifeId now; sight is aggregated per owning user
        // so all of a player's concurrent characters union their vision.
        for (const [key, player] of Object.entries(tile.players)) {
          if (!player) continue;
          const owner = player.uid || key;
          if (!owner) continue;
          if (!worldMap.has(owner)) worldMap.set(owner, new Set());
          // Ethnicity/trait can widen a character's vision (e.g. Norvel +1 sight).
          const playerSight = DEFAULT_PLAYER_SIGHT + geneticMod(player, 'sight');
          _addCircle(worldMap.get(owner), x, y, nightAdjust(playerSight));
        }
      }

      if (tile.structure?.owner && tile.structure.owner !== 'monster') {
        const uid   = tile.structure.owner;
        const type  = tile.structure.type;
        const range = tile.structure.sightRange
          ?? STRUCTURE_SIGHT_OVERRIDES[type]
          ?? DEFAULT_STRUCTURE_SIGHT;
        if (!worldMap.has(uid)) worldMap.set(uid, new Set());
        _addCircle(worldMap.get(uid), x, y, range);

        const score = moralityByUid?.[uid];
        const beaconR = _beaconRadius(score);
        if (beaconR > 0) _addCircle(beacon, x, y, beaconR);
      }
    }
  }

  _cache.set(worldId, worldMap);
  _beaconCache.set(worldId, beacon);
  _builtAt.set(worldId, Date.now());
}

/**
 * Rebuild the cache from current DB state if the existing build is older than
 * `maxAgeMs`. Coalesces concurrent calls so we only do one DB load at a time.
 *
 * This bridges the gap between ticks: action handlers (move, spawn, mobilise)
 * mutate the DB without rebuilding visibility, leaving the cache anchored to
 * the previous tick's positions. Calling this before serving a chunk request
 * keeps the visibility radius live.
 */
// Force the next refreshIfStale to rebuild. Call after an action mutates a
// player's sight sources (spawn, mobilise, move) so a chunk fetch immediately
// afterwards reflects the new position instead of a pre-action cache — without
// this, a just-spawned player can fetch chunks filtered against stale
// visibility and see structures/buildings only their player-sight covers blink
// out until the next tick rebuild.
export function invalidate(worldId) {
  _builtAt.set(worldId, 0);
}

export async function refreshIfStale(db, worldId, maxAgeMs = 2000) {
  const last = _builtAt.get(worldId) || 0;
  if (Date.now() - last < maxAgeMs) return;
  if (_refreshing.has(worldId)) return _refreshing.get(worldId);

  const p = (async () => {
    try {
      // Visibility is built purely from sight sources (groups/players/structures),
      // which only ever live in active chunks — pure terrain contributes nothing.
      // So load active-only here, avoiding a full-world scan on this hot path.
      const chunkDocs = await db.collection('chunks')
        .find({ worldId, active: { $ne: false } }).toArray();
      const chunks = {};
      for (const c of chunkDocs) chunks[c.chunkKey] = c.tiles || {};

      const moralityByUid = {};
      try {
        const playerDocs = await db.collection('players')
          .find({ [`worlds.${worldId}.morality`]: { $exists: true } },
                { projection: { _id: 1, [`worlds.${worldId}.morality.score`]: 1 } })
          .toArray();
        for (const p of playerDocs) {
          const s = p.worlds?.[worldId]?.morality?.score;
          if (typeof s === 'number') moralityByUid[p._id] = s;
        }
      } catch (err) {
        console.error(`[visibility] morality fetch ${worldId}:`, err);
      }

      // Current in-world time drives the night sight penalty.
      let tickCount = 0;
      try {
        const w = await db.collection('worlds').findOne({ _id: worldId }, { projection: { 'info.tickCount': 1 } });
        tickCount = Number(w?.info?.tickCount) || 0;
      } catch { /* default day */ }

      updateWorldVisibility(worldId, chunks, moralityByUid, tickCount);
    } catch (err) {
      console.error(`[visibility] refresh ${worldId}:`, err);
    } finally {
      _refreshing.delete(worldId);
    }
  })();

  _refreshing.set(worldId, p);
  return p;
}

/**
 * Returns the Set<"x,y"> of tiles visible to userId in worldId,
 * or null if no cache entry exists yet (→ caller should show everything).
 *
 * Tiles visible via the morality beacon are added in for every player.
 */
export function getVisibleTiles(userId, worldId) {
  const own = _cache.get(worldId)?.get(userId);
  const beacon = _beaconCache.get(worldId);
  if (!own && !beacon) return null;
  if (!beacon) return own;
  if (!own) return new Set(beacon);

  // Combine — beacons add to visibility but don't replace it.
  const combined = new Set(own);
  for (const t of beacon) combined.add(t);
  return combined;
}

/**
 * Filter a tiles object so that entity data is stripped from tiles the player
 * cannot see.  An explicit empty object `{}` is sent for tiles that currently
 * carry entity data but are outside visibility — this tells the client to clear
 * any previously cached entity state for those tiles.
 *
 * tiles: { [tileKey]: tileData }  (as stored in DB / broadcast by tick)
 */
export function filterTilesForPlayer(userId, worldId, tiles) {
  const visible = getVisibleTiles(userId, worldId);
  if (!visible) return tiles; // cache not ready → show everything

  const result = {};
  for (const [tileKey, tileData] of Object.entries(tiles)) {
    if (visible.has(tileKey)) {
      result[tileKey] = tileData;
    } else if (_hasEntityData(tileData)) {
      result[tileKey] = {}; // clear stale entity cache on client
    }
  }
  return result;
}

function _hasEntityData(tile) {
  return !!(tile?.groups || tile?.structure || tile?.players || tile?.battles || tile?.items);
}
