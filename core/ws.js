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

// subscriptions: Map<ws, Set<string>>  — channelKey per socket
const subscriptions = new Map();

let _wss;

// Heroku kills WebSocket connections idle for >55 s (H15 error).
// Ping every 30 s to keep connections alive; close any that miss a pong.
const PING_INTERVAL_MS = 30_000;

export function attachWss(server) {
  _wss = new WebSocketServer({ server });

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

    ws.on('close', () => subscriptions.delete(ws));
    ws.on('error', () => subscriptions.delete(ws));
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

function handleClientMessage(ws, msg) {
  const subs = subscriptions.get(ws);
  if (!subs) return;

  switch (msg.type) {
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
  broadcast(chunkChannel(worldId, chunkKey), { type: 'chunk_update', worldId, chunkKey, tiles });
}

export function broadcastWorldTick(worldId, info) {
  broadcast(worldChannel(worldId), { type: 'world_tick', worldId, info });
}

export function broadcastChatMessage(worldId, message) {
  broadcast(chatChannel(worldId), { type: 'chat_message', worldId, message });
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
