/**
 * Structure passive-production tick.
 *
 * For each tile that hosts a structure with productive buildings, generates
 * a small per-tick output (based on building type & level), credits it to
 * the structure's `items` pool — up to a per-structure storage cap — and skims
 * the configured tax % into the world's `coffers` collection.
 *
 * Buildings recognised:
 *   mine     → METAL_ORE / STONE
 *   farm     → WHEAT / BERRIES
 *   smithy   → CRUDE_WEAPON (slower)
 *   workshop → WOOD (slower)
 *
 * GOLD is NOT produced passively — currency is only earned through play
 * (trade, bounties, taxes), never minted by simply owning a market.
 *
 * Output is produced only every PRODUCTION_INTERVAL ticks and each item is
 * capped at STORAGE_CAP_PER_LEVEL × structure level, so stores fill slowly and
 * never accumulate without bound.
 */
import { merge } from 'gisaima-shared/economy/items.js';
import { BUILDINGS } from 'gisaima-shared/definitions/BUILDINGS.js';
import { applyProductionTax } from '../db/productionTax.js';

// Which defined building bonus scales each producer's passive yield. The bonus
// is cumulative across levels (see BUILDINGS.getCumulativeBonuses) and applied
// as a multiplier (1 + bonus), so a mine at L4 with miningYield 0.3 yields ×1.3.
const YIELD_BONUS_KEY = {
  mine: 'miningYield',
  farm: 'farmingYield',
};

// Produce once every N ticks rather than every tick — keeps the economy slow.
const PRODUCTION_INTERVAL = 5;

// Per-item storage ceiling for passive production, scaled by structure level.
const STORAGE_CAP_PER_LEVEL = 200;

// Each entry: [itemCode, base, perLevel, minLevel?]. minLevel gates rare outputs
// behind the building level that "unlocks" them in BUILDINGS.benefits, so a
// levelled Mine actually starts yielding gold/silver (L3) and mithril/adamantite
// (L5) rather than that only being a flavour string.
const BUILDING_OUTPUT = {
  mine:     [
    ['METAL_ORE',  1, 0.34],
    ['STONE',      1, 0.5],
    ['GOLD_ORE',   1, 0.2,  3],
    ['SILVER_ORE', 1, 0.2,  3],
    ['MITHRIL_ORE', 1, 0.1, 5],
    ['ADAMANTITE',  1, 0.0, 5],
  ],
  farm:     [['WHEAT',          1, 0.5], ['BERRIES',     1, 0.25]],
  smithy:   [['CRUDE_WEAPON',   1, 0.2]],
  workshop: [['WOOD',  1, 0.34]],
  market:   [], // commerce, not passive minting — no GOLD here
  barracks: [], // produces via the recruit queue, not passively
  wall:     [],
  academy:  [],
  harbour:  [],
};

function _outputFor(buildings, globalMult = 1) {
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
    // Scale yield by the building's defined cumulative bonus for its level, so
    // levelling a mine/farm actually increases output through the real bonus.
    const bonusKey = YIELD_BONUS_KEY[b.type];
    const yieldMult = bonusKey ? 1 + BUILDINGS.getBonusValue(b.type, level, bonusKey) : 1;
    for (const [key, base, perLevel, minLevel] of recipe) {
      if (minLevel && level < minLevel) continue; // rare output gated by building level
      const qty = Math.floor((base + perLevel * (level - 1)) * yieldMult * globalMult);
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
export async function processStructureProduction(db, worldId, chunks, ops, tickCount = 0, productionMultiplier = 1) {
  let producedStructures = 0;
  let totalTaxed = 0;
  const cofferDelta = {};

  // Slow the economy down: only produce on every PRODUCTION_INTERVAL-th tick.
  if (Number(tickCount) % PRODUCTION_INTERVAL !== 0) {
    return { producedStructures, totalTaxed };
  }

  for (const [chunkKey, tiles] of Object.entries(chunks || {})) {
    for (const [tileKey, tile] of Object.entries(tiles || {})) {
      const s = tile?.structure;
      if (!s) continue;
      if (s.status === 'ruin' || s.abandoned) continue;
      if (!s.buildings) continue;

      const output = _outputFor(s.buildings, productionMultiplier);
      if (!Object.keys(output).length) continue;

      const { kept, taxed } = applyProductionTax(output, s.taxes || {});

      // Credit kept items to the structure's store, capped per item so passive
      // production can't run away. The cap only limits what production adds — it
      // never trims items already stored (e.g. player deposits).
      if (Object.keys(kept).length) {
        const merged = merge(s.items || {}, kept);
        const cap = STORAGE_CAP_PER_LEVEL * Math.max(1, Number(s.level) || 1);
        for (const code of Object.keys(kept)) {
          const norm = code.toUpperCase();
          const added = kept[code] || 0;
          const prev = (merged[norm] || 0) - added;   // store before this tick's output
          if (merged[norm] > cap) merged[norm] = Math.max(prev, cap);
        }
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
