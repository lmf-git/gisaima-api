import { apiError } from '../core/auth.js';
import { getRecentChat } from '../db/chat.js';
import { filterTilesForPlayer, refreshIfStale, getVisibleTiles } from '../lib/visibility.js';

export async function getWorlds(db) {
  const worlds = await db.collection('worlds').find({}, { projection: { info: 1 } }).toArray();
  return worlds.map(w => ({ id: w._id, ...w.info }));
}

export async function getWorld(db, worldId) {
  const world = await db.collection('worlds').findOne({ _id: worldId }, { projection: { info: 1 } });
  if (!world) throw apiError(404, 'world not found');
  return { id: world._id, ...world.info };
}

export async function getChunk(db, worldId, chunkKey, userId = null) {
  if (userId) await refreshIfStale(db, worldId);
  const doc   = await db.collection('chunks').findOne({ worldId, chunkKey });
  const tiles = doc?.tiles || {};
  return userId ? filterTilesForPlayer(userId, worldId, tiles) : tiles;
}

// Chat history with the same fog-of-war as the live broadcast: location-tagged
// messages are only returned to a player whose current visibility covers that
// tile. Global (location-less) messages and the player's own messages always
// come through. Anonymous/no-uid requests get the unfiltered feed.
export async function getWorldChat(db, worldId, userId = null) {
  const messages = await getRecentChat(db, worldId, 100);
  if (!userId) return messages;

  await refreshIfStale(db, worldId);
  const visible = getVisibleTiles(userId, worldId);
  if (!visible) return messages; // cache not ready → show everything (safe default)

  return messages.filter(m => {
    const loc = m?.location;
    const hasLoc = loc && Number.isFinite(loc.x) && Number.isFinite(loc.y);
    if (!hasLoc) return true;                          // global / realm-wide
    if (m.userId && m.userId === userId) return true;  // author hears themselves
    return visible.has(`${loc.x},${loc.y}`);
  });
}
