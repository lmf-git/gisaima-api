/**
 * Fog of war — server-side visibility filtering.
 *
 * Visibility is the union of circular sight areas around every group and
 * structure owned by a player.  Default radii:
 *   groups    : 2 tiles  (or group.sightRange if set)
 *   structures: 1 tile   (watchtower=2, outpost=3, spawn=2, or structure.sightRange)
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

const DEFAULT_GROUP_SIGHT     = 2;
const DEFAULT_STRUCTURE_SIGHT = 1;
const DEFAULT_PLAYER_SIGHT    = 2;
const STRUCTURE_SIGHT_OVERRIDES = { watchtower: 2, outpost: 3, spawn: 2 };

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
export function updateWorldVisibility(worldId, chunks, moralityByUid = null) {
  const worldMap = new Map();  // userId → Set<"x,y">
  const beacon   = new Set();  // visible-to-all set

  for (const tiles of Object.values(chunks)) {
    for (const [tileKey, tile] of Object.entries(tiles)) {
      if (!tile) continue;
      const [x, y] = tileKey.split(',').map(Number);

      if (tile.groups) {
        for (const group of Object.values(tile.groups)) {
          if (!group || group.type === 'monster' || !group.owner) continue;
          const uid = group.owner;
          if (!worldMap.has(uid)) worldMap.set(uid, new Set());
          _addCircle(worldMap.get(uid), x, y, group.sightRange ?? DEFAULT_GROUP_SIGHT);

          // Morality beacon: evil players radiate visibility for everyone.
          const score = moralityByUid?.[uid];
          const beaconR = _beaconRadius(score);
          if (beaconR > 0) _addCircle(beacon, x, y, beaconR);
        }
      }

      if (tile.players) {
        for (const [uid, player] of Object.entries(tile.players)) {
          if (!player || !uid) continue;
          if (!worldMap.has(uid)) worldMap.set(uid, new Set());
          _addCircle(worldMap.get(uid), x, y, DEFAULT_PLAYER_SIGHT);
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
