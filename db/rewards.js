/**
 * Reward sink resolution — there is no global player wallet. Items and
 * currency live inside structures and groups on chunk tiles. When a system
 * pays a player (bounty, loan, trade settlement, etc.) we deposit into one of:
 *
 *   1. The structure the player is currently standing on (if any)
 *   2. The group the player is currently in (if any)
 *   3. The first structure the player founded (their "home")
 *
 * Items are merged into `tile.structure.items` or `tile.groups.<id>.items`.
 * Gold is just the special item key `GOLD`.
 *
 * `pay(db, ops, worldId, uid, items, { preferStructure })` returns the sink
 * descriptor or null if the player has no resolvable location.
 */
import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { merge } from 'gisaima-shared/economy/items.js';

/**
 * Find the chunk + tile + (structure or group) that should receive
 * a payment to `uid`. Returns:
 *   { worldId, chunkKey, tileKey, kind: 'structure'|'group', id?, items }
 * or null if no sink can be resolved.
 */
export async function resolveSink(db, worldId, uid, { preferStructure = true } = {}) {
  // 1. Standing-on-tile resolution from the player's last-known location.
  const player = await db.collection('players').findOne(
    { _id: uid },
    { projection: { [`worlds.${worldId}`]: 1 } }
  );
  const w = player?.worlds?.[worldId];
  const loc = w?.lastLocation || w?.location;

  if (loc && Number.isFinite(loc.x) && Number.isFinite(loc.y)) {
    const chunkKey = getChunkKey(loc.x, loc.y);
    const tileKey  = `${loc.x},${loc.y}`;
    const chunkDoc = await db.collection('chunks').findOne(
      { worldId, chunkKey },
      { projection: { [`tiles.${tileKey}`]: 1 } }
    );
    const tile = chunkDoc?.tiles?.[tileKey];

    if (tile) {
      if (preferStructure && tile.structure?.owner === uid) {
        return {
          worldId, chunkKey, tileKey,
          kind: 'structure',
          items: tile.structure.items || {}
        };
      }
      // Player's own group at this tile.
      const myGroupId = Object.entries(tile.groups || {}).find(
        ([, g]) => g?.owner === uid
      )?.[0];
      if (myGroupId) {
        return {
          worldId, chunkKey, tileKey,
          kind: 'group', id: myGroupId,
          items: tile.groups[myGroupId].items || {}
        };
      }
      // Any allied structure (uid is a member) standing on it.
      if (tile.structure?.members?.includes?.(uid)) {
        return {
          worldId, chunkKey, tileKey,
          kind: 'structure',
          items: tile.structure.items || {}
        };
      }
    }
  }

  // 2. Fallback to the player's home (first founded) structure.
  if (w?.homeStructure) {
    const { chunkKey, tileKey } = w.homeStructure;
    const chunkDoc = await db.collection('chunks').findOne(
      { worldId, chunkKey },
      { projection: { [`tiles.${tileKey}`]: 1 } }
    );
    const tile = chunkDoc?.tiles?.[tileKey];
    if (tile?.structure) {
      return {
        worldId, chunkKey, tileKey,
        kind: 'structure',
        items: tile.structure.items || {}
      };
    }
  }

  return null;
}

/**
 * Try to charge `cost` items from the player's resolved sink. Returns
 * { ok: true, sink } on success, or { ok: false, reason } if the sink can't
 * cover the cost.
 */
export async function charge(db, ops, worldId, uid, cost) {
  const sink = await resolveSink(db, worldId, uid);
  if (!sink) return { ok: false, reason: 'no sink available' };

  // Verify ALL keys present in sufficient quantity.
  for (const [k, q] of Object.entries(cost)) {
    if ((sink.items?.[k] || 0) < q) {
      return { ok: false, reason: `insufficient ${k}` };
    }
  }

  // Build the post-charge items map.
  const next = { ...(sink.items || {}) };
  for (const [k, q] of Object.entries(cost)) {
    next[k] = (next[k] || 0) - q;
    if (next[k] <= 0) delete next[k];
  }

  const path = sink.kind === 'structure'
    ? `${sink.tileKey}.structure.items`
    : `${sink.tileKey}.groups.${sink.id}.items`;
  ops.chunk(worldId, sink.chunkKey, path, next);
  return { ok: true, sink };
}

/**
 * Deposit `items` into the player's resolved sink.
 * Returns the sink descriptor (or null if no sink).
 */
export async function pay(db, ops, worldId, uid, items, opts = {}) {
  if (!items || !Object.keys(items).length) return null;
  const sink = await resolveSink(db, worldId, uid, opts);
  if (!sink) return null;

  const merged = merge(sink.items || {}, items);
  const path = sink.kind === 'structure'
    ? `${sink.tileKey}.structure.items`
    : `${sink.tileKey}.groups.${sink.id}.items`;
  ops.chunk(worldId, sink.chunkKey, path, merged);
  return sink;
}

/**
 * Sum a player's total wealth across every structure they own.
 * Used by the wealth ranking — there is no per-player gold field.
 */
export async function totalGoldForPlayer(db, worldId, uid, itemKey = 'GOLD') {
  const chunks = await db.collection('chunks')
    .find({ worldId }, { projection: { tiles: 1 } })
    .toArray();
  let total = 0;
  for (const chunk of chunks) {
    for (const tile of Object.values(chunk.tiles || {})) {
      if (tile.structure?.owner === uid) {
        total += Number(tile.structure.items?.[itemKey] || 0);
      }
      for (const group of Object.values(tile.groups || {})) {
        if (group?.owner === uid) {
          total += Number(group.items?.[itemKey] || 0);
        }
      }
    }
  }
  return total;
}
