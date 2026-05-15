/**
 * Fog of war — server-side visibility filtering.
 *
 * Visibility is the union of circular sight areas around every group and
 * structure owned by a player.  Default radii:
 *   groups    : 2 tiles  (or group.sightRange if set)
 *   structures: 1 tile   (watchtower=2, outpost=3, spawn=2, or structure.sightRange)
 *
 * The cache is rebuilt once per world tick and queried during chunk broadcasts
 * and HTTP chunk requests.
 */

const DEFAULT_GROUP_SIGHT     = 2;
const DEFAULT_STRUCTURE_SIGHT = 1;
const STRUCTURE_SIGHT_OVERRIDES = { watchtower: 2, outpost: 3, spawn: 2 };

// Cache: Map<worldId, Map<userId, Set<"x,y">>>
const _cache = new Map();

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
 */
export function updateWorldVisibility(worldId, chunks) {
  const worldMap = new Map(); // userId → Set<"x,y">

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
      }
    }
  }

  _cache.set(worldId, worldMap);
}

/**
 * Returns the Set<"x,y"> of tiles visible to userId in worldId,
 * or null if no cache entry exists yet (→ caller should show everything).
 */
export function getVisibleTiles(userId, worldId) {
  return _cache.get(worldId)?.get(userId) ?? null;
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
