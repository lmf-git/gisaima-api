/**
 * Transfer items between a structure's shared storage (`structure.items`) and
 * the caller's personal bank (`structure.banks[uid]`) at the same structure.
 *
 * direction:
 *   'toBank'   — move from shared storage → your bank
 *   'toShared' — move from your bank → shared storage
 *
 * Either direction touches the communal shared pool, so both require the
 * structure's `deposit` permission (same gate as demobilise-into-shared).
 */
import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { Ops } from '../../lib/ops.js';
import { canUse } from '../../structures/access.js';

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export async function transferStorage({ uid, data, db }) {
  const { worldId = 'default', tileX, tileY, direction, items } = data;

  if (tileX === undefined || tileY === undefined) throw err(400, 'Missing tile coordinates');
  if (!['toBank', 'toShared'].includes(direction))  throw err(400, 'Invalid transfer direction');
  if (!items || typeof items !== 'object' || !Object.keys(items).length) {
    throw err(400, 'No items specified');
  }

  const chunkKey = getChunkKey(tileX, tileY);
  const tileKey  = `${tileX},${tileY}`;
  const chunkDoc = await db.collection('chunks').findOne({ worldId, chunkKey });
  const tile      = chunkDoc?.tiles?.[tileKey] || {};
  const structure = tile.structure;
  if (!structure) throw err(409, 'No structure at this location');

  const allowed = await canUse({ db, worldId, structure, uid, action: 'deposit' });
  if (!allowed) throw err(403, "You do not have permission to use this structure's shared storage");

  const shared = { ...(structure.items || {}) };
  const bank   = { ...(structure.banks?.[uid] || {}) };
  const from = direction === 'toBank' ? shared : bank;
  const to   = direction === 'toBank' ? bank   : shared;

  let moved = 0;
  for (const [code, qtyRaw] of Object.entries(items)) {
    if (code.startsWith('_')) continue;
    const qty  = Math.floor(Number(qtyRaw));
    if (!(qty > 0)) continue;
    const have = Math.floor(Number(from[code]) || 0);
    if (have <= 0) throw err(400, `Nothing to move: ${code}`);
    const take = Math.min(qty, have);
    from[code] = have - take;
    if (from[code] <= 0) delete from[code];
    to[code] = (Math.floor(Number(to[code]) || 0)) + take;
    moved += take;
  }
  if (moved <= 0) throw err(400, 'Nothing was moved');

  const newShared = direction === 'toBank' ? from : to;
  const newBank   = direction === 'toBank' ? to   : from;

  const ops = new Ops();
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.items`, newShared);
  // An empty bank is unset so it stops appearing as a bank for this player.
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.banks.${uid}`,
    Object.keys(newBank).length ? newBank : null);

  await ops.flush(db);

  return { ok: true, moved, items: newShared, bank: newBank };
}

export default transferStorage;
