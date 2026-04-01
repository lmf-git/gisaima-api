import { apiError } from '../core/auth.js';
import { insertChatMessage, trimChatMessages } from '../db/chat.js';
import { broadcastChatMessage } from '../core/ws.js';

export async function postChat(db, auth, worldId, body) {
  const { text, type = 'user', location = null } = body;
  if (!text || !text.trim()) throw apiError(400, 'text required');
  if (text.length > 200)     throw apiError(400, 'message too long');
  const userDoc = await db.collection('users').findOne({ _id: auth.uid });
  const msg = {
    text: text.trim(), type,
    timestamp: Date.now(),
    userId: auth.uid,
    userName: userDoc?.displayName || 'Anonymous',
    location
  };
  const id = await insertChatMessage(db, worldId, msg);
  await trimChatMessages(db, worldId, 500);
  broadcastChatMessage(worldId, { id: id.toString(), ...msg });
  return { success: true };
}
