// The only sub-fields ever written to a tile (verified across events/ + routes/).
// Used to recognise a "husk" tile — one whose every key is a known content slot,
// all empty — which is safe to remove entirely.
const TILE_CONTENT_KEYS = ['groups', 'battles', 'structure', 'players', 'items'];

/** Whether a single tile holds live-work entities (excludes ground items). */
function tileHasLiveWork(t) {
  if (!t) return false;
  if (t.structure) return true;
  if (t.battles && Object.keys(t.battles).length) return true;
  if (t.groups  && Object.keys(t.groups).length)  return true;
  if (t.players && Object.keys(t.players).length) return true;
  return false;
}

/** Whether a single tile holds any persisted content (live work OR ground items). */
function tileHasContent(t) {
  if (tileHasLiveWork(t)) return true;
  return !!(t?.items && Object.keys(t.items).length);
}

/**
 * Whether a tile is a removable husk: it carries no content AND every key it
 * does have is a known (now-empty) content slot — e.g. `{ groups: {} }` left
 * behind when the last group moved out. Tiles with an unrecognised field are
 * never pruned, so we can't accidentally drop data we don't know about.
 */
export function isTileHusk(t) {
  if (!t || typeof t !== 'object') return false;
  if (tileHasContent(t)) return false;
  for (const k in t) if (!TILE_CONTENT_KEYS.includes(k)) return false;
  return true;
}

/**
 * Whether a chunk needs ticking: it hosts at least one tile with unit/monster
 * groups, an active battle, a structure, or a standalone character (a
 * demobilised player sitting in `tile.players`, which the cleanup tick must be
 * able to reach). Mirrors the `WORK_PATH` promotion rule in lib/ops.js — keep
 * the two in sync. Pure explored terrain (and tiles holding only ground
 * `items`, which nothing processes per-tick) is inert and skipped each tick.
 */
export function hasLiveWork(tiles) {
  if (!tiles) return false;
  for (const tileKey in tiles) if (tileHasLiveWork(tiles[tileKey])) return true;
  return false;
}

/**
 * Whether a chunk holds *any* persisted content worth keeping: live-work
 * entities (groups/battles/structure/players) OR ground `items` (loot with no
 * per-tick processor, but still real player data). A chunk failing this check
 * is pure terrain — fully reconstructible from the world seed — so it can be
 * deleted to reclaim storage rather than kept as an empty husk. Strictly
 * weaker than hasLiveWork: every live-work chunk has content, but an
 * items-only chunk has content yet needs no ticking.
 */
export function hasAnyContent(tiles) {
  if (!tiles) return false;
  for (const tileKey in tiles) if (tileHasContent(tiles[tileKey])) return true;
  return false;
}

export async function getChunkDoc(db, worldId, chunkKey) {
  return db.collection('chunks').findOne({ worldId, chunkKey });
}

/** Returns tiles object (tileKey → tileData) for a chunk, or {} */
export async function getChunkTiles(db, worldId, chunkKey) {
  const doc = await db.collection('chunks').findOne(
    { worldId, chunkKey },
    { projection: { tiles: 1 } }
  );
  return doc?.tiles || {};
}

/** Upsert specific fields inside a chunk's tiles subdocument */
export async function patchChunkTiles(db, worldId, chunkKey, dotPaths) {
  // dotPaths: { 'tileKey.groups.groupId.status': 'idle', ... }
  const $set   = {};
  const $unset = {};
  for (const [path, value] of Object.entries(dotPaths)) {
    if (value === null || value === undefined) $unset[`tiles.${path}`] = '';
    else $set[`tiles.${path}`] = value;
  }
  const update = {};
  if (Object.keys($set).length)   update.$set   = $set;
  if (Object.keys($unset).length) update.$unset = $unset;
  if (!Object.keys(update).length) return;
  await db.collection('chunks').updateOne({ worldId, chunkKey }, update, { upsert: true });
}
