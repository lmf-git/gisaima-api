/**
 * Whether a chunk needs ticking: it hosts at least one tile with unit/monster
 * groups, an active battle, or a structure. Mirrors the `WORK_PATH` promotion
 * rule in lib/ops.js — keep the two in sync. Chunks of pure explored terrain
 * (no groups/battles/structures) are inert and can be skipped each tick.
 */
export function hasLiveWork(tiles) {
  if (!tiles) return false;
  for (const tileKey in tiles) {
    const t = tiles[tileKey];
    if (!t) continue;
    if (t.structure) return true;
    if (t.battles && Object.keys(t.battles).length) return true;
    if (t.groups && Object.keys(t.groups).length) return true;
  }
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
