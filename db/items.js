/**
 * Tile-level item drops. Items left at a tile by death, by trade
 * interception, or by an explicit drop action live inside the chunk
 * itself — on `tile.items` — so they flow through the existing
 * `chunk_update` WebSocket broadcast and show up in the client's
 * `entities.items[tileKey]` store with no extra fetch.
 *
 *   tile.items: { [ITEM_KEY]: qty }
 *
 * Players standing on a tile can drop items from their reward sink
 * (a structure or group they own there) onto `tile.items`, and pick
 * items up off `tile.items` into their sink.
 */
import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { merge } from 'gisaima-shared/economy/items.js';
import { Ops } from './../lib/ops.js';
import { charge, pay, resolveSink } from './rewards.js';

function _subtract(have, take) {
  const next = { ...have };
  const removed = {};
  for (const [k, q] of Object.entries(take)) {
    const got = Math.min(q, next[k] || 0);
    if (got > 0) {
      removed[k] = got;
      next[k] = (next[k] || 0) - got;
      if (next[k] <= 0) delete next[k];
    }
  }
  return { next, removed };
}

async function _readTileItems(db, worldId, x, y) {
  const chunkKey = getChunkKey(x, y);
  const tileKey  = `${x},${y}`;
  const chunk = await db.collection('chunks').findOne(
    { worldId, chunkKey },
    { projection: { [`tiles.${tileKey}.items`]: 1 } }
  );
  return {
    chunkKey,
    tileKey,
    items: chunk?.tiles?.[tileKey]?.items || {}
  };
}

export async function listAt(db, worldId, x, y) {
  const { items } = await _readTileItems(db, worldId, x, y);
  if (!Object.keys(items).length) return [];
  // Same shape callers used to expect: an array of {items} drops at the tile.
  return [{ x, y, items }];
}

export async function dropAtCurrentLocation(db, worldId, uid, drop) {
  if (!drop || !Object.keys(drop).length) throw new Error('items required');

  const sink = await resolveSink(db, worldId, uid);
  if (!sink) throw new Error('no resolvable sink to drop from');

  const ops = new Ops();
  const charged = await charge(db, ops, worldId, uid, drop);
  if (!charged.ok) throw new Error(charged.reason);

  const [x, y] = sink.tileKey.split(',').map(Number);
  const { chunkKey, tileKey, items: existing } = await _readTileItems(db, worldId, x, y);
  const next = merge(existing, drop);
  ops.chunk(worldId, chunkKey, `${tileKey}.items`, next);
  await ops.flush(db);

  return { ok: true, x, y, items: next };
}

export async function pickupAtCurrentLocation(db, worldId, uid, want) {
  if (!want || !Object.keys(want).length) throw new Error('items required');

  const sink = await resolveSink(db, worldId, uid);
  if (!sink) throw new Error('no resolvable sink to pick up into');
  const [x, y] = sink.tileKey.split(',').map(Number);

  const { chunkKey, tileKey, items: existing } = await _readTileItems(db, worldId, x, y);
  const { next, removed } = _subtract(existing, want);
  if (!Object.keys(removed).length) throw new Error('nothing matching to pick up');

  const ops = new Ops();
  ops.chunk(worldId, chunkKey, `${tileKey}.items`, Object.keys(next).length ? next : null);
  await pay(db, ops, worldId, uid, removed);
  await ops.flush(db);

  return { ok: true, picked: removed };
}

/**
 * Used by lives.addDeath (and any other system that needs to drop items
 * onto a tile without a player-side sink charge). Merges into existing
 * `tile.items` via ops.
 */
export async function dropAtTile(db, ops, worldId, x, y, items) {
  if (!items || !Object.keys(items).length) return;
  const { chunkKey, tileKey, items: existing } = await _readTileItems(db, worldId, x, y);
  ops.chunk(worldId, chunkKey, `${tileKey}.items`, merge(existing, items));
}
