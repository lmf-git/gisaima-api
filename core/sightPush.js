/**
 * Targeted visibility push.
 *
 * When a player's sight changes (move, mobilise, demobilise, spawn) the tiles
 * that newly come into — or drop out of — view belong to chunks that did NOT
 * themselves change this tick, so the normal "broadcast changed chunks" pass
 * never re-sends them. Rather than have the client re-fetch every loaded chunk
 * over HTTP, the server already knows which chunks that player's sockets watch
 * (their WS subscriptions); we re-filter just those chunks against the player's
 * fresh visibility and push them straight to that player's sockets.
 *
 * `chunk_update` is the exact message the client already handles, so the pushed
 * tiles flow through the normal entity-merge path (including the empty-`{}`
 * tiles that clear entities/items that left view).
 */
import { getUserChunkSubscriptions, broadcastToUser } from './ws.js';
import { filterTilesForPlayer, refreshIfStale } from '../lib/visibility.js';

/**
 * @param {object} db
 * @param {string} worldId
 * @param {string} userId
 * @param {object} [opts]
 * @param {Set<string>} [opts.exclude] chunkKeys already broadcast this tick (skip — the
 *   client already got them with current visibility).
 * @param {number} [opts.maxAgeMs] visibility cache freshness tolerance (default 2000).
 */
export async function pushVisibleChunks(db, worldId, userId, { exclude = null, maxAgeMs = 2000 } = {}) {
  if (!userId) return;
  const chunkKeys = getUserChunkSubscriptions(userId, worldId);
  if (!chunkKeys.size) return;

  // Ensure the visibility cache reflects the sight change before we filter.
  await refreshIfStale(db, worldId, maxAgeMs);

  const wanted = exclude ? [...chunkKeys].filter(k => !exclude.has(k)) : [...chunkKeys];
  if (!wanted.length) return;

  const docs = await db.collection('chunks')
    .find({ worldId, chunkKey: { $in: wanted } })
    .toArray();

  for (const doc of docs) {
    const filtered = filterTilesForPlayer(userId, worldId, doc.tiles || {});
    broadcastToUser(userId, { type: 'chunk_update', worldId, chunkKey: doc.chunkKey, tiles: filtered });
  }
}
