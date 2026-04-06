/**
 * Crafting tick processing for Gisaima
 */

import { Ops } from '../lib/ops.js';

export async function processCrafting(worldId, worldData, db) {
  try {
    const now         = Date.now();
    const craftingData = worldData?.crafting;
    if (!craftingData) return { processed: 0 };

    let processed = 0;
    const ops = new Ops();

    for (const [craftingId, crafting] of Object.entries(craftingData)) {
      if (crafting.processed || crafting.status !== 'in_progress') continue;

      if (typeof crafting.ticksRequired === 'number') {
        if (typeof crafting.ticksCompleted !== 'number') {
          ops.world(worldId, `crafting.${craftingId}.ticksCompleted`, 1);
          continue;
        }
        const newTicks = crafting.ticksCompleted + 1;
        ops.world(worldId, `crafting.${craftingId}.ticksCompleted`, newTicks);
        if (newTicks >= crafting.ticksRequired) {
          completeCrafting(worldId, craftingId, crafting, ops, now);
          processed++;
        }
      } else if (crafting.completesAt && crafting.completesAt <= now) {
        completeCrafting(worldId, craftingId, crafting, ops, now);
        processed++;
      } else if (crafting.craftingTime) {
        ops.world(worldId, `crafting.${craftingId}.ticksRequired`,  crafting.craftingTime);
        ops.world(worldId, `crafting.${craftingId}.ticksCompleted`, 1);
      }
    }

    await ops.flush(db);
    return { processed };
  } catch (err) {
    console.error('Error processing crafting:', err);
    return { processed: 0, error: err.message };
  }
}

function completeCrafting(worldId, craftingId, crafting, ops, now) {
  ops.world(worldId, `crafting.${craftingId}.status`,    'completed');
  ops.world(worldId, `crafting.${craftingId}.processed`, true);

  if (crafting.playerId && crafting.result) {
    const newItemId = `item_${now}_${Math.floor(Math.random() * 1000)}`;
    ops.player(crafting.playerId, worldId, `inventory.${newItemId}`, {
      ...crafting.result, id: newItemId, craftedAt: now
    });
  }

  if (crafting.playerId) {
    ops.player(crafting.playerId, worldId, 'crafting.current',     null);
    ops.player(crafting.playerId, worldId, 'crafting.completesAt', null);
    const notifId = `crafting_completed_${craftingId}`;
    ops.player(crafting.playerId, worldId, `notifications.${notifId}`, {
      id: notifId, type: 'crafting_completed',
      message: `You have completed crafting ${crafting.result?.name}!`,
      craftingId, itemName: crafting.result?.name, read: false
    });
  }

  ops.chat(worldId, {
    location: crafting.structureLocation,
    text: `${crafting.playerName} completed crafting ${crafting.result?.name}.`,
    timestamp: now, type: 'event'
  });
}
