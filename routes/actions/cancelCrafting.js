import { applyUpdates } from '../../db/adapter.js';

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

  for (const [matName, amount] of Object.entries(crafting.materials)) {
    const refund = Math.floor(amount * 0.9);
    if (refund <= 0) continue;
    const existing = updatedInv.find(i => i.name === matName);
    if (existing) existing.quantity += refund;
    else updatedInv.push({ name: matName, quantity: refund, type: 'resource' });
  }

  const updates = {
    [`worlds/${worldId}/crafting/${craftingId}/status`]:     'canceled',
    [`worlds/${worldId}/crafting/${craftingId}/canceledAt`]: now,
    [`worlds/${worldId}/crafting/${craftingId}/processed`]:  true,
    [`players/${uid}/worlds/${worldId}/crafting/current`]:   null,
    [`players/${uid}/worlds/${worldId}/crafting/completesAt`]: null,
    [`players/${uid}/worlds/${worldId}/inventory`]:           updatedInv,
    [`worlds/${worldId}/chat/cancel_crafting_${craftingId}`]: {
      location: crafting.structureLocation,
      text: `${crafting.playerName} canceled crafting ${crafting.result.name}.`,
      timestamp: now, type: 'event'
    }
  };

  await applyUpdates(db, updates);
  return { success: true };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export default cancelCrafting;
