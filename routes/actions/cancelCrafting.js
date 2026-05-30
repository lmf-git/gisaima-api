import { ITEMS } from 'gisaima-shared/definitions/ITEMS.js';
import { Ops } from '../../lib/ops.js';

// Resolve an inventory item to its canonical ITEMS code.
function itemCode(item) {
  if (!item) return '';
  if (item.code && ITEMS[item.code]) return item.code;
  if (item.id && ITEMS[item.id]) return item.id;
  if (item.name) {
    const k = Object.keys(ITEMS).find(c => ITEMS[c].name === item.name);
    if (k) return k;
  }
  return (item.code || item.id || item.name || '').toString().toUpperCase().replace(/ /g, '_');
}

export async function cancelCrafting({ uid, data, db }) {
  const { worldId, craftingId } = data;
  if (!worldId || !craftingId) throw err(400, 'Missing required parameters');

  const worldDoc = await db.collection('worlds').findOne({ _id: worldId });
  const crafting = worldDoc?.crafting?.[craftingId];
  if (!crafting)                    throw err(404, 'Crafting not found');
  if (crafting.playerId !== uid)    throw err(403, 'You cannot cancel this crafting');
  if (crafting.processed || crafting.status !== 'in_progress') {
    throw err(409, 'This crafting cannot be canceled');
  }

  const now = Date.now();

  const playerDoc  = await db.collection('players').findOne({ _id: uid });
  const player     = playerDoc?.worlds?.[worldId] || {};
  const inventory  = player.inventory || [];
  const updatedInv = Array.isArray(inventory) ? [...inventory] : Object.values(inventory);

  // crafting.materials is keyed by item code; refund 90% matched by code.
  for (const [matCode, amount] of Object.entries(crafting.materials)) {
    const refund = Math.floor(amount * 0.9);
    if (refund <= 0) continue;
    const existing = updatedInv.find(i => itemCode(i) === matCode);
    if (existing) existing.quantity += refund;
    else updatedInv.push({ code: matCode, name: ITEMS[matCode]?.name || matCode, quantity: refund, type: 'resource' });
  }

  const ops = new Ops();
  ops.world(worldId, `crafting.${craftingId}.status`,     'canceled');
  ops.world(worldId, `crafting.${craftingId}.canceledAt`, now);
  ops.world(worldId, `crafting.${craftingId}.processed`,  true);
  ops.player(uid, worldId, 'crafting.current',     null);
  ops.player(uid, worldId, 'crafting.completesAt', null);
  ops.player(uid, worldId, 'inventory',            updatedInv);
  ops.chat(worldId, {
    location: crafting.structureLocation,
    text: `${crafting.playerName} canceled crafting ${crafting.result.name}.`,
    timestamp: now, type: 'event', category: 'player', userId: uid
  });

  await ops.flush(db);
  return { success: true };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export default cancelCrafting;
