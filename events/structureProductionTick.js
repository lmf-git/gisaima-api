/**
 * Structure passive-production tick.
 *
 * For each tile that hosts a structure with productive buildings, generates
 * a small per-tick output (based on building type & level), credits it to
 * the structure's `items` pool, and skims the configured tax % into the
 * world's `coffers` collection.
 *
 * Buildings recognised:
 *   mine     → METAL_ORE / STONE
 *   farm     → WHEAT / BERRIES
 *   smithy   → CRUDE_WEAPON (slower)
 *   workshop → WOOD (slower)
 *   market   → GOLD (commerce yield)
 *
 * The output rates are deliberately modest — they fill stores over many
 * ticks rather than swamping the economy.
 */
import { merge } from 'gisaima-shared/economy/items.js';
import { applyProductionTax } from '../db/productionTax.js';

const BUILDING_OUTPUT = {
  mine:     [['METAL_ORE',       1, 0.5], ['STONE', 2, 1.0]],
  quarry:   [['STONE',   3, 1.5]],
  lumberyard: [['WOOD', 4, 2.0]],
  farm:     [['WHEAT',          3, 1.5], ['BERRIES',     1, 0.5]],
  smithy:   [['CRUDE_WEAPON',   1, 0.2]],
  workshop: [['WOOD',  2, 1.0]],
  market:   [['GOLD',           5, 2.5]],
  stable:   [['LEATHER',        1, 0.4]],
  barracks: [], // produces via the recruit queue, not passively
  wall:     [],
  academy:  [],
  harbour:  [],
  port:     []
};

function _outputFor(buildings) {
  const out = {};
  if (!buildings) return out;
  // buildings may be { type: { level }, ... } or [{ type, level }, ...]
  const list = Array.isArray(buildings)
    ? buildings
    : Object.entries(buildings).map(([type, b]) => ({ type, ...(b || {}) }));
  for (const b of list) {
    const recipe = BUILDING_OUTPUT[b.type];
    if (!recipe?.length) continue;
    const level = Math.max(1, Number(b.level) || 1);
    for (const [key, base, perLevel] of recipe) {
      const qty = Math.floor(base + perLevel * (level - 1));
      if (qty > 0) out[key] = (out[key] || 0) + qty;
    }
  }
  return out;
}

/**
 * Run the production tick for one world. `chunks` is the in-memory map
 * already loaded by core/tick.js — we don't re-fetch.
 *
 * Returns counts: { produced, taxed (gold-equivalent units), structures }
 */
export async function processStructureProduction(db, worldId, chunks, ops) {
  let producedStructures = 0;
  let totalTaxed = 0;
  const cofferDelta = {};

  for (const [chunkKey, tiles] of Object.entries(chunks || {})) {
    for (const [tileKey, tile] of Object.entries(tiles || {})) {
      const s = tile?.structure;
      if (!s) continue;
      if (s.status === 'ruin' || s.abandoned) continue;
      if (!s.buildings) continue;

      const output = _outputFor(s.buildings);
      if (!Object.keys(output).length) continue;

      const { kept, taxed } = applyProductionTax(output, s.taxes || {});

      // Credit kept items to the structure's store.
      if (Object.keys(kept).length) {
        const merged = merge(s.items || {}, kept);
        ops.chunk(worldId, chunkKey, `${tileKey}.structure.items`, merged);
        producedStructures++;
      }

      // Aggregate taxed slice into the world coffers (one update per world
      // at the end; smaller transaction count).
      for (const [k, q] of Object.entries(taxed)) {
        if (q <= 0) continue;
        cofferDelta[`items.${k}`] = (cofferDelta[`items.${k}`] || 0) + q;
        if (k === 'GOLD') totalTaxed += q;
      }
    }
  }

  if (Object.keys(cofferDelta).length) {
    await db.collection('coffers').updateOne(
      { _id: worldId },
      { $inc: cofferDelta },
      { upsert: true }
    );
  }

  return { producedStructures, totalTaxed };
}
