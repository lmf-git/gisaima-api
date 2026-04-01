import { apiError } from '../core/auth.js';
import { getRecentChat } from '../db/chat.js';

export async function getWorlds(db) {
  const worlds = await db.collection('worlds').find({}, { projection: { info: 1 } }).toArray();
  return worlds.map(w => ({ id: w._id, ...w.info }));
}

export async function getWorld(db, worldId) {
  const world = await db.collection('worlds').findOne({ _id: worldId });
  if (!world) throw apiError(404, 'world not found');
  return { id: world._id, ...world.info };
}

export async function getChunk(db, worldId, chunkKey) {
  const doc = await db.collection('chunks').findOne({ worldId, chunkKey });
  return doc?.tiles || {};
}

export async function getWorldChat(db, worldId) {
  return getRecentChat(db, worldId, 100);
}
