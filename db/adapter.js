/**
 * Firebase-path → MongoDB adapter.
 *
 * Converts a flat Firebase-style `updates` object (used throughout the
 * existing tick/event handlers) into MongoDB bulk operations.
 *
 * Handles these path shapes:
 *   worlds/{worldId}/info/{...}           → worlds
 *   worlds/{worldId}/upgrades/{...}       → worlds
 *   worlds/{worldId}/chunks/{chk}/{rest}  → chunks (tiles sub-doc)
 *   worlds/{worldId}/chat/{msgId}         → chat (insert/upsert)
 *   players/{userId}/{rest}               → players
 *
 * null value = delete ($unset).
 */
export async function applyUpdates(db, updates) {
  const worldOps    = new Map();   // worldId → { $set, $unset }
  const chunkOps    = new Map();   // "worldId__chunkKey" → { worldId, chunkKey, $set, $unset }
  const chatUpserts = [];
  const playerOps   = new Map();   // userId → { $set, $unset }

  for (let [rawPath, value] of Object.entries(updates)) {
    const path  = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;
    const parts = path.split('/');

    if (parts[0] === 'worlds') {
      const worldId = parts[1];
      if (!worldId) continue;

      if (parts[2] === 'chunks') {
        const chunkKey   = parts[3];
        if (!chunkKey) continue;
        const innerParts = parts.slice(4);
        const key = `${worldId}__${chunkKey}`;
        if (!chunkOps.has(key)) chunkOps.set(key, { worldId, chunkKey, $set: {}, $unset: {} });
        const op = chunkOps.get(key);
        if (innerParts.length) {
          const mongoPath = `tiles.${innerParts.join('.')}`;
          if (value === null) op.$unset[mongoPath] = '';
          else op.$set[mongoPath] = value;
        } else if (value && typeof value === 'object') {
          for (const [tileKey, tileData] of Object.entries(value)) {
            if (tileData === null) op.$unset[`tiles.${tileKey}`] = '';
            else op.$set[`tiles.${tileKey}`] = tileData;
          }
        }

      } else if (parts[2] === 'chat') {
        const msgId = parts[3];
        if (msgId && value !== null && typeof value === 'object') {
          chatUpserts.push({ _id: msgId, worldId, ...value });
        }

      } else {
        const innerPath = parts.slice(2).join('.');
        if (!worldOps.has(worldId)) worldOps.set(worldId, { $set: {}, $unset: {} });
        const op = worldOps.get(worldId);
        if (value === null) op.$unset[innerPath] = '';
        else op.$set[innerPath] = value;
      }

    } else if (parts[0] === 'players') {
      const userId = parts[1];
      if (!userId) continue;
      const innerPath = parts.slice(2).join('.');
      if (!playerOps.has(userId)) playerOps.set(userId, { $set: {}, $unset: {} });
      const op = playerOps.get(userId);
      if (innerPath) {
        if (value === null) op.$unset[innerPath] = '';
        else op.$set[innerPath] = value;
      } else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          if (v === null) op.$unset[k] = '';
          else op.$set[k] = v;
        }
      }
    }
  }

  const ops = [];

  for (const [worldId, { $set, $unset }] of worldOps) {
    const u = _buildUpdate($set, $unset);
    if (u) ops.push(db.collection('worlds').updateOne({ _id: worldId }, u, { upsert: true }));
  }

  for (const [, { worldId, chunkKey, $set, $unset }] of chunkOps) {
    const u = _buildUpdate($set, $unset);
    if (u) ops.push(db.collection('chunks').updateOne({ worldId, chunkKey }, u, { upsert: true }));
  }

  for (const msg of chatUpserts) {
    ops.push(db.collection('chat').updateOne(
      { _id: msg._id },
      { $setOnInsert: msg },
      { upsert: true }
    ));
  }

  for (const [userId, { $set, $unset }] of playerOps) {
    const u = _buildUpdate($set, $unset);
    if (u) ops.push(db.collection('players').updateOne({ _id: userId }, u, { upsert: true }));
  }

  await Promise.all(ops);
}

function _buildUpdate($set, $unset) {
  const u = {};
  if (Object.keys($set).length)   u.$set   = $set;
  if (Object.keys($unset).length) u.$unset = $unset;
  return Object.keys(u).length ? u : null;
}
