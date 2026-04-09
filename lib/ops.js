/**
 * MongoDB-native bulk operation accumulator for the game tick.
 *
 * Instead of Firebase-style path strings, callers use typed methods with
 * explicit collection targets and MongoDB dot-notation paths. Everything is
 * flushed in a single parallel batch via flush(db).
 */

import { broadcastChatMessage } from '../core/ws.js';

export class Ops {
  constructor() {
    this._chunks  = new Map(); // `worldId\0chunkKey` → { worldId, chunkKey, $set, $unset }
    this._worlds  = new Map(); // worldId            → { $set, $unset }
    this._players = new Map(); // userId             → { $set, $unset }
    this._chat    = [];
  }

  /**
   * Set a field inside a chunk's tiles sub-document.
   * @param {string} path - MongoDB dot-notation relative to `tiles`,
   *   e.g. `${tileKey}.groups.${groupId}.status`
   */
  chunk(worldId, chunkKey, path, value) {
    const key = `${worldId}\0${chunkKey}`;
    if (!this._chunks.has(key)) this._chunks.set(key, { worldId, chunkKey, $set: {}, $unset: {} });
    const op = this._chunks.get(key);
    const full = `tiles.${path}`;

    if (value === null || value === undefined) {
      op.$unset[full] = '';
      delete op.$set[full];
      // Remove child entries that would conflict with the parent unset.
      // Matches MongoDB behaviour where unsetting a parent removes all descendants.
      const prefix = full + '.';
      for (const k of Object.keys(op.$set))   if (k.startsWith(prefix)) delete op.$set[k];
      for (const k of Object.keys(op.$unset)) if (k !== full && k.startsWith(prefix)) delete op.$unset[k];
    } else {
      // Status priority: idle > fighting > moving > mobilizing — prevent lower-priority
      // status from overwriting a higher-priority one set earlier in the same tick.
      if (path.endsWith('.status') && full in op.$set) {
        const pri = { idle: 3, fighting: 2, moving: 1, mobilizing: 0 };
        if ((pri[value] ?? -1) <= (pri[op.$set[full]] ?? -1)) return;
      }
      op.$set[full] = value;
      delete op.$unset[full];
    }
  }

  /**
   * Set a field on a world document.
   * @param {string} path - MongoDB dot-notation, e.g. `upgrades.${id}.processed`
   */
  world(worldId, path, value) {
    if (!this._worlds.has(worldId)) this._worlds.set(worldId, { $set: {}, $unset: {} });
    const op = this._worlds.get(worldId);
    if (value === null || value === undefined) op.$unset[path] = '';
    else op.$set[path] = value;
  }

  /**
   * Set a field in a player's world sub-document.
   * @param {string} path - relative to `worlds.${worldId}`,
   *   e.g. `lastLocation` or `inventory`
   */
  /**
   * Set a field in a player document.
   * @param {string|null} worldId - World prefix. Pass null for top-level player paths
   *   (e.g. `notifications.someId`).
   */
  player(userId, worldId, path, value) {
    if (!this._players.has(userId)) this._players.set(userId, { $set: {}, $unset: {} });
    const op = this._players.get(userId);
    const full = worldId ? `worlds.${worldId}.${path}` : path;
    if (value === null || value === undefined) op.$unset[full] = '';
    else op.$set[full] = value;
  }

  /** Queue a chat message insert. */
  chat(worldId, msg) {
    this._chat.push({ worldId, timestamp: Date.now(), ...msg });
  }

  /** Flush all accumulated operations to MongoDB in parallel. */
  async flush(db) {
    const ops = [];

    for (const { worldId, chunkKey, $set, $unset } of this._chunks.values()) {
      const u = _build($set, $unset);
      if (u) ops.push(db.collection('chunks').updateOne({ worldId, chunkKey }, u, { upsert: true }));
    }

    for (const [worldId, { $set, $unset }] of this._worlds) {
      const u = _build($set, $unset);
      if (u) ops.push(db.collection('worlds').updateOne({ _id: worldId }, u, { upsert: true }));
    }

    for (const [userId, { $set, $unset }] of this._players) {
      const u = _build($set, $unset);
      if (u) ops.push(db.collection('players').updateOne({ _id: userId }, u, { upsert: true }));
    }

    for (const msg of this._chat) {
      ops.push(
        db.collection('chat').insertOne(msg).then(result => {
          broadcastChatMessage(msg.worldId, { id: result.insertedId.toString(), ...msg });
        })
      );
    }

    await Promise.all(ops);
  }
}

function _build($set, $unset) {
  const u = {};
  if (Object.keys($set).length)   u.$set   = $set;
  if (Object.keys($unset).length) u.$unset = $unset;
  return Object.keys(u).length ? u : null;
}
