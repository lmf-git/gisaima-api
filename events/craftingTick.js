/**
 * Crafting tick processing for Gisaima
 */

import { Ops } from '../lib/ops.js';
import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { merge } from 'gisaima-shared/economy/items.js';

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
          await completeCrafting(db, worldId, worldData, craftingId, crafting, ops, now);
          processed++;
        }
      } else if (crafting.completesAt && crafting.completesAt <= now) {
        await completeCrafting(db, worldId, worldData, craftingId, crafting, ops, now);
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

/**
 * Probabilistic structure-tax on crafting output. Per the design doc, items
 * produced at a smithy/workshop tithe a share to the steward's coffers.
 * Since crafting outputs a single item per completion, the tax rate becomes
 * the probability that *this* completion's output is diverted to the host
 * structure's stores instead of the player's inventory. Returns true if
 * routed to the structure.
 */
async function _maybeTaxCraftedItem(db, worldId, crafting, ops, now) {
  const loc = crafting.structureLocation;
  if (!loc || typeof loc.x !== 'number' || typeof loc.y !== 'number') return false;
  const chunkKey = getChunkKey(loc.x, loc.y);
  const tileKey  = `${loc.x},${loc.y}`;
  const chunk = await db.collection('chunks').findOne(
    { worldId, chunkKey },
    { projection: { [`tiles.${tileKey}.structure`]: 1 } }
  );
  const structure = chunk?.tiles?.[tileKey]?.structure;
  const rate = Number(structure?.taxes?.trade) || 0;
  if (rate <= 0) return false;
  if (Math.random() >= rate / 100) return false;

  const key = (crafting.result?.code || crafting.result?.id || crafting.result?.name || 'CRAFTED').toString().toUpperCase().replace(/\s+/g, '_');
  const next = merge(structure?.items || {}, { [key]: 1 });
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.items`, next);
  ops.chat(worldId, {
    location: loc,
    text: `The steward's coffers claim the ${rate}% smithing tithe — 1× ${(crafting.result?.name || key)} routed to the structure.`,
    timestamp: now, type: 'event'
  });
  return true;
}

async function completeCrafting(db, worldId, worldData, craftingId, crafting, ops, now) {
  ops.world(worldId, `crafting.${craftingId}.status`,    'completed');
  ops.world(worldId, `crafting.${craftingId}.processed`, true);

  let routedToStructure = false;
  if (crafting.playerId && crafting.result) {
    routedToStructure = await _maybeTaxCraftedItem(db, worldId, crafting, ops, now);
    if (!routedToStructure) {
      const newItemId = `item_${now}_${Math.floor(Math.random() * 1000)}`;
      ops.player(crafting.playerId, worldId, `inventory.${newItemId}`, {
        ...crafting.result, id: newItemId, craftedAt: now
      });
    }
  }

  if (crafting.playerId) {
    ops.player(crafting.playerId, worldId, 'crafting.current',     null);
    ops.player(crafting.playerId, worldId, 'crafting.completesAt', null);
    const notifId = `crafting_completed_${craftingId}`;
    ops.player(crafting.playerId, worldId, `notifications.${notifId}`, {
      id: notifId, type: 'crafting_completed',
      message: routedToStructure
        ? `Your ${crafting.result?.name} was taxed by the smithy.`
        : `You have completed crafting ${crafting.result?.name}!`,
      craftingId, itemName: crafting.result?.name, read: false
    });
  }

  if (!routedToStructure) {
    ops.chat(worldId, {
      location: crafting.structureLocation,
      text: `${crafting.playerName} completed crafting ${crafting.result?.name}.`,
      timestamp: now, type: 'event'
    });
  }
}

