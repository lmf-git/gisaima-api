/**
 * Crafting tick processing for Gisaima
 */

import { applyUpdates } from '../db/adapter.js';

export async function processCrafting(worldId, worldData, db) {
  try {
    const now         = Date.now();
    const craftingData = worldData?.crafting;
    if (!craftingData) return { processed: 0 };

    let processed = 0;
    const updates = {};

    for (const [craftingId, crafting] of Object.entries(craftingData)) {
      if (crafting.processed || crafting.status !== 'in_progress') continue;

      if (typeof crafting.ticksRequired === 'number') {
        if (typeof crafting.ticksCompleted !== 'number') {
          updates[`worlds/${worldId}/crafting/${craftingId}/ticksCompleted`] = 1;
          continue;
        }
        const newTicks = crafting.ticksCompleted + 1;
        updates[`worlds/${worldId}/crafting/${craftingId}/ticksCompleted`] = newTicks;
        if (newTicks >= crafting.ticksRequired) {
          completeCrafting(worldId, craftingId, crafting, updates);
          processed++;
        }
      } else if (crafting.completesAt && crafting.completesAt <= now) {
        completeCrafting(worldId, craftingId, crafting, updates);
        processed++;
      } else if (crafting.craftingTime) {
        updates[`worlds/${worldId}/crafting/${craftingId}/ticksRequired`]   = crafting.craftingTime;
        updates[`worlds/${worldId}/crafting/${craftingId}/ticksCompleted`]  = 1;
      }
    }

    if (Object.keys(updates).length > 0) await applyUpdates(db, updates);
    return { processed };
  } catch (err) {
    console.error('Error processing crafting:', err);
    return { processed: 0, error: err.message };
  }
}

function completeCrafting(worldId, craftingId, crafting, updates) {
  const now = Date.now();
  updates[`worlds/${worldId}/crafting/${craftingId}/status`]    = 'completed';
  updates[`worlds/${worldId}/crafting/${craftingId}/processed`] = true;

  if (crafting.playerId && crafting.result) {
    const newItemId = `item_${now}_${Math.floor(Math.random() * 1000)}`;
    updates[`players/${crafting.playerId}/worlds/${worldId}/inventory/${newItemId}`] = {
      ...crafting.result, id: newItemId, craftedAt: now
    };
  }

  if (crafting.playerId) {
    updates[`players/${crafting.playerId}/worlds/${worldId}/crafting/current`]     = null;
    updates[`players/${crafting.playerId}/worlds/${worldId}/crafting/completesAt`] = null;
    const notifId = `crafting_completed_${craftingId}`;
    updates[`players/${crafting.playerId}/worlds/${worldId}/notifications/${notifId}`] = {
      id: notifId, type: 'crafting_completed',
      message: `You have completed crafting ${crafting.result?.name}!`,
      craftingId, itemName: crafting.result?.name, read: false
    };
  }

  updates[`worlds/${worldId}/chat/crafting_complete_${craftingId}`] = {
    location: crafting.structureLocation,
    text: `${crafting.playerName} completed crafting ${crafting.result?.name}.`,
    timestamp: now, type: 'event'
  };
}
