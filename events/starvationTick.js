/**
 * Starvation tick for Gisaima.
 *
 * Runs as the FIRST pass of a world tick — before battles, movement and other
 * group activity — so that a unit can never starve to death in the middle of a
 * battle that the same tick is about to resolve. Hunger is settled first; the
 * survivors then fight/move.
 *
 * Model:
 *  - Every unit in a player-owned group (and every garrisoned unit in a
 *    player-owned structure) needs FOOD_PER_UNIT nourishment each tick.
 *  - Nourishment is drawn from the food items the group / structure is carrying
 *    (items flagged `food` in ITEMS, weighted by their `nourishment`). Lower-
 *    nourishment foods are eaten first so prized rations last.
 *  - If there isn't enough food, the unfed units starve and are removed. The
 *    player's own character unit is never removed by starvation (going hungry
 *    has no lethal effect on the controlled character), but it still eats, so a
 *    lone player depletes stores.
 *  - Monsters don't eat — their population is governed separately.
 */

import { isFood, getNourishment } from 'gisaima-shared/definitions/ITEMS.js';

const FOOD_PER_UNIT = 1; // nourishment one unit consumes per tick

const asList = (units) => Array.isArray(units) ? units : Object.values(units || {});
const isPlayerUnit = (u) => u?.type === 'player';

// Consume up to `need` nourishment from an items bag (code → qty), eating
// lowest-nourishment foods first. Returns the new bag and any unmet shortfall.
function consumeNourishment(items, need) {
  const out = { ...(items || {}) };
  let remaining = need;
  if (remaining <= 0) return { items: out, shortfall: 0 };

  const foodCodes = Object.keys(out)
    .filter(c => !c.startsWith('_') && isFood(c) && getNourishment(c) > 0)
    .sort((a, b) => getNourishment(a) - getNourishment(b));

  for (const code of foodCodes) {
    if (remaining <= 0) break;
    const per = getNourishment(code);
    const qty = Number(out[code]) || 0;
    const use = Math.min(qty, Math.ceil(remaining / per));
    if (use <= 0) continue;
    out[code] = qty - use;
    if (out[code] <= 0) delete out[code];
    remaining -= use * per;
  }

  return { items: out, shortfall: Math.max(0, remaining) };
}

// Remove up to `count` non-player units, preserving the original container shape.
// Returns the new units collection and the list of removed units.
function starveUnits(units, count) {
  if (count <= 0) return { units, removed: [] };
  const removed = [];

  if (Array.isArray(units)) {
    const kept = [];
    for (const u of units) {
      if (removed.length < count && !isPlayerUnit(u)) { removed.push(u); continue; }
      kept.push(u);
    }
    return { units: kept, removed };
  }

  const out = { ...(units || {}) };
  for (const [id, u] of Object.entries(out)) {
    if (removed.length >= count) break;
    if (isPlayerUnit(u)) continue;
    removed.push(u);
    delete out[id];
  }
  return { units: out, removed };
}

const unitLabel = (n) => `${n} unit${n === 1 ? '' : 's'}`;

/**
 * Settle hunger for one world tick. Mutates state through `ops`.
 * chunks: { [chunkKey]: { [tileKey]: tile } } (in-memory snapshot for this tick)
 */
export function processStarvation(worldId, ops, chunks, now) {
  let starvedUnits = 0;

  for (const chunkKey in chunks) {
    const chunk = chunks[chunkKey];
    for (const tileKey in chunk) {
      const tile = chunk[tileKey];
      if (!tile) continue;

      // ── Player-owned groups in the field ──────────────────────────────
      if (tile.groups) {
        for (const groupId in tile.groups) {
          const group = tile.groups[groupId];
          if (!group || group.type === 'monster' || !group.owner) continue;

          const units = asList(group.units);
          if (!units.length) continue;

          const need = units.length * FOOD_PER_UNIT;
          const { items: newItems, shortfall } = consumeNourishment(group.items, need);
          // Mutate the in-memory snapshot too so the later passes this tick
          // (battles, movement) act on the post-starvation state.
          group.items = newItems;
          ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.items`, newItems);

          if (shortfall <= 0) continue;

          const nonPlayer = units.filter(u => !isPlayerUnit(u)).length;
          const toStarve  = Math.min(nonPlayer, Math.ceil(shortfall / FOOD_PER_UNIT));
          if (toStarve <= 0) continue;

          const { units: survivors, removed } = starveUnits(group.units, toStarve);
          starvedUnits += removed.length;

          const survivorList = asList(survivors);
          if (survivorList.length === 0) {
            // Whole group wiped out by famine.
            delete tile.groups[groupId];
            ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}`, null);
          } else {
            group.units = survivors;
            ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.units`, survivors);
          }

          ops.chat(worldId, {
            text: `${group.name || 'A force'} ran out of food — ${unitLabel(removed.length)} starved at (${tile.x},${tile.y}).`,
            timestamp: now, type: 'event', category: 'player', userId: group.owner,
            location: { x: tile.x, y: tile.y }
          });
        }
      }

      // ── Garrisoned units inside a player-owned structure ──────────────
      const struct = tile.structure;
      if (struct && struct.owner && struct.owner !== 'monster' && struct.units) {
        // Total mouths to feed across every owner's garrison.
        let totalUnits = 0;
        const garrisons = struct.units;
        for (const ownerId in garrisons) totalUnits += asList(garrisons[ownerId]).length;
        if (totalUnits === 0) continue;

        const need = totalUnits * FOOD_PER_UNIT;
        const { items: newItems, shortfall } = consumeNourishment(struct.items, need);
        struct.items = newItems;
        ops.chunk(worldId, chunkKey, `${tileKey}.structure.items`, newItems);

        if (shortfall <= 0) continue;

        // Spread the famine across garrisons, removing non-player units.
        let toStarve = Math.ceil(shortfall / FOOD_PER_UNIT);
        let removedTotal = 0;
        for (const ownerId in garrisons) {
          if (toStarve <= 0) break;
          const { units: survivors, removed } = starveUnits(garrisons[ownerId], toStarve);
          if (!removed.length) continue;
          toStarve     -= removed.length;
          removedTotal += removed.length;
          garrisons[ownerId] = survivors;
          ops.chunk(worldId, chunkKey, `${tileKey}.structure.units.${ownerId}`, survivors);
        }

        if (removedTotal > 0) {
          starvedUnits += removedTotal;
          ops.chat(worldId, {
            text: `The garrison at ${struct.name || 'a structure'} went hungry — ${unitLabel(removedTotal)} starved at (${tile.x},${tile.y}).`,
            timestamp: now, type: 'event', category: 'player', userId: struct.owner,
            location: { x: tile.x, y: tile.y }
          });
        }
      }
    }
  }

  return { starvedUnits };
}

export default processStarvation;
