import { Ops } from '../../lib/ops.js';

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
    timestamp: now, type: 'event'
  });

  await ops.flush(db);
  return { success: true };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export default cancelCrafting;
