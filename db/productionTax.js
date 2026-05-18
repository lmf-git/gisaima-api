/**
 * Production tax — when a group produces items on a tile that hosts a
 * structure with tax rates configured, a slice of the output is diverted
 * into the structure's stores (the steward's "coffers"). The remainder is
 * credited to the producer as normal.
 *
 * Tax categories: `trade`, `building`, `mine`, `farm` (per /settlement UI).
 * The helper picks the category most relevant to each item key.
 */
import { merge } from 'gisaima-shared/economy/items.js';

function _categoryFor(itemKey) {
  const k = (itemKey || '').toUpperCase();
  if (k.includes('WHEAT') || k.includes('GRAIN') || k.includes('BERRY') ||
      k.includes('HERB')  || k.includes('FOOD')  || k.includes('FRUIT')) return 'farm';
  if (k.includes('ORE')   || k.includes('IRON')  || k.includes('STONE') ||
      k.includes('CRYSTAL') || k.includes('GEM')  || k.includes('COAL')) return 'mine';
  if (k.includes('WOOD')  || k.includes('STICK') || k.includes('LOG')   ||
      k.includes('TIMBER')) return 'building';
  return 'trade';
}

/**
 * Split `items` ({ KEY: qty }) by the structure's per-category tax rate.
 * Returns { kept, taxed } — both same-shaped maps. Either may be empty.
 *
 * Tax is rounded *down* so producers always get the lion's share; any sub-1
 * tax remainder accrues invisibly to the producer (no fractional items).
 */
export function applyProductionTax(items, structureTaxes) {
  if (!items || typeof items !== 'object') return { kept: {}, taxed: {} };
  if (!structureTaxes || typeof structureTaxes !== 'object') {
    return { kept: { ...items }, taxed: {} };
  }

  const kept = {};
  const taxed = {};
  for (const [k, q] of Object.entries(items)) {
    const qty = Number(q) || 0;
    if (qty <= 0) continue;
    const rate = Number(structureTaxes[_categoryFor(k)] || 0);
    if (rate <= 0) {
      kept[k] = (kept[k] || 0) + qty;
      continue;
    }
    const cut = Math.floor((qty * rate) / 100);
    if (cut > 0) taxed[k] = (taxed[k] || 0) + cut;
    const left = qty - cut;
    if (left > 0) kept[k] = (kept[k] || 0) + left;
  }
  return { kept, taxed };
}

/**
 * Convenience: split AND apply via ops. Writes taxed items into the tile's
 * structure.items and returns the `kept` map for the producer to use.
 * No-op (returns the input unchanged) when no taxable structure is present.
 */
export function splitAndCreditStructure(ops, worldId, chunkKey, tileKey, tile, items) {
  const structure = tile?.structure;
  if (!structure || !structure.taxes || structure.status === 'ruin') {
    return { kept: items, taxed: null };
  }
  const { kept, taxed } = applyProductionTax(items, structure.taxes);
  if (Object.keys(taxed).length > 0) {
    const merged = merge(structure.items || {}, taxed);
    ops.chunk(worldId, chunkKey, `${tileKey}.structure.items`, merged);
  }
  return { kept, taxed };
}
