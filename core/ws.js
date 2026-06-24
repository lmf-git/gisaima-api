/**
 * WebSocket hub.
 *
 * Clients subscribe to specific channels:
 *   { type: 'subscribe_chunk', worldId, chunkKey }
 *   { type: 'subscribe_world', worldId }
 *   { type: 'subscribe_chat',  worldId }
 *
 * Server broadcasts:
 *   { type: 'chunk_update',  worldId, chunkKey, tiles }
 *   { type: 'world_tick',    worldId, info }
 *   { type: 'chat_message',  worldId, message }
 */

import { WebSocketServer } from 'ws';
import { verifyToken } from './auth.js';
import { filterTilesForPlayer, getVisibleTiles } from '../lib/visibility.js';

// subscriptions: Map<ws, Set<string>>  — channelKey per socket
const subscriptions = new Map();
// wsUserIds: Map<ws, string>  — authenticated userId per socket
const wsUserIds = new Map();

let _wss;

// Heroku kills WebSocket connections idle for >55 s (H15 error).
// Ping every 30 s to keep connections alive; close any that miss a pong.
const PING_INTERVAL_MS = 30_000;

export function attachWss(server) {
  _wss = new WebSocketServer({
    server,
    // Compress larger frames (chunk_update payloads benefit most). Tuned for a
    // shared 512MB dyno: skip small frames, cap concurrent compressions, and
    // disable context takeover so each connection's zlib state stays cheap —
    // a small ratio cost for bounded per-socket memory with many clients.
    perMessageDeflate: {
      threshold:               1024,
      concurrencyLimit:        10,
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      zlibDeflateOptions:      { level: 6, memLevel: 7 },
    },
  });

  _wss.on('connection', ws => {
    subscriptions.set(ws, new Set());
    ws.isAlive = true;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw);
        handleClientMessage(ws, msg);
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', () => { subscriptions.delete(ws); wsUserIds.delete(ws); });
    ws.on('error', () => { subscriptions.delete(ws); wsUserIds.delete(ws); });
  });

  // Heartbeat: ping all clients every 30 s, terminate any that don't pong back.
  const heartbeat = setInterval(() => {
    if (!_wss) { clearInterval(heartbeat); return; }
    for (const ws of _wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, PING_INTERVAL_MS);

  _wss.on('close', () => clearInterval(heartbeat));
}

/** Number of currently-connected WebSocket clients (for /metrics). */
export function getClientCount() {
  return _wss ? _wss.clients.size : 0;
}

/** Close all client sockets and the WS server (called on graceful shutdown). */
export function closeWss() {
  if (!_wss) return;
  for (const ws of _wss.clients) {
    try { ws.close(1001, 'server shutting down'); } catch { /* ignore */ }
  }
  _wss.close();
  _wss = null;
}

function handleClientMessage(ws, msg) {
  const subs = subscriptions.get(ws);
  if (!subs) return;

  switch (msg.type) {
    case 'authenticate': {
      const auth = verifyToken(msg.token);
      if (auth?.uid) wsUserIds.set(ws, auth.uid);
      break;
    }
    case 'subscribe_chunk':
      subs.add(chunkChannel(msg.worldId, msg.chunkKey));
      break;
    case 'unsubscribe_chunk':
      subs.delete(chunkChannel(msg.worldId, msg.chunkKey));
      break;
    case 'subscribe_world':
      subs.add(worldChannel(msg.worldId));
      break;
    case 'unsubscribe_world':
      subs.delete(worldChannel(msg.worldId));
      break;
    case 'subscribe_chat':
      subs.add(chatChannel(msg.worldId));
      break;
    case 'unsubscribe_chat':
      subs.delete(chatChannel(msg.worldId));
      break;
  }
}

// ---------------------------------------------------------------------------
// Broadcast helpers (called by tick.js and action handlers)
// ---------------------------------------------------------------------------

export function broadcastChunkUpdate(worldId, chunkKey, tiles) {
  if (!_wss) return;
  const channel = chunkChannel(worldId, chunkKey);
  for (const [ws, subs] of subscriptions) {
    if (!subs.has(channel) || ws.readyState !== 1) continue;
    const userId   = wsUserIds.get(ws);
    const filtered = userId ? filterTilesForPlayer(userId, worldId, tiles) : tiles;
    ws.send(JSON.stringify({ type: 'chunk_update', worldId, chunkKey, tiles: filtered }));
  }
}

export function broadcastWorldTick(worldId, info) {
  broadcast(worldChannel(worldId), { type: 'world_tick', worldId, info });
}

/**
 * Chat fan-out with fog-of-war. Messages tagged with a map `location` are only
 * delivered to subscribers who can currently see that tile (their visibility
 * radius), so players don't overhear events outside their sight. Messages
 * without a location (global/realm chat) reach every chat subscriber. The
 * author always receives their own message regardless of sight.
 */
export function broadcastChatMessage(worldId, message) {
  if (!_wss) return;
  const channel = chatChannel(worldId);
  const loc = message?.location;
  const hasLoc = loc && Number.isFinite(loc.x) && Number.isFinite(loc.y);

  if (!hasLoc) {
    broadcast(channel, { type: 'chat_message', worldId, message });
    return;
  }

  const tileKey = `${loc.x},${loc.y}`;
  const data = JSON.stringify({ type: 'chat_message', worldId, message });
  for (const [ws, subs] of subscriptions) {
    if (!subs.has(channel) || ws.readyState !== 1 /* OPEN */) continue;
    const userId = wsUserIds.get(ws);
    // Author always hears themselves.
    if (userId && userId === message.userId) { ws.send(data); continue; }
    // null visibility = cache not built yet → don't hide (safe default, matching
    // the chunk filter). Otherwise gate strictly on the visible-tiles set.
    const visible = userId ? getVisibleTiles(userId, worldId) : null;
    if (!visible || visible.has(tileKey)) ws.send(data);
  }
}

/** Send a message to all authenticated sockets belonging to a specific user. */
export function broadcastToUser(userId, payload) {
  if (!_wss) return;
  const data = JSON.stringify(payload);
  for (const [ws, uid] of wsUserIds) {
    if (uid === userId && ws.readyState === 1 /* OPEN */) ws.send(data);
  }
}

function broadcast(channel, payload) {
  if (!_wss) return;
  const data = JSON.stringify(payload);
  for (const [ws, subs] of subscriptions) {
    if (subs.has(channel) && ws.readyState === 1 /* OPEN */) {
      ws.send(data);
    }
  }
}

const chunkChannel = (w, c) => `chunk:${w}:${c}`;
const worldChannel = w      => `world:${w}`;
const chatChannel  = w      => `chat:${w}`;
