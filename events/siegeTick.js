/**
 * Siege tick — sustained pressure on structures without open battle.
 *
 * Hostile player groups camped idle on another player's structure tile put it
 * under siege: each tick the structure loses 1% of its durability. When its
 * health falls to the critical threshold (15% of durability — same line
 * battleTick uses), the siege ends: the besieger with the most units captures
 * it, or it collapses into ruins if no besieger remains to claim it. Leaving
 * the tile lifts the siege (the counter resets; the damage remains).
 *
 * Spawn structures cannot be besieged (protected like they are from attack),
 * and tiles with an active battle are skipped — battle damage governs there.
 */
import { STRUCTURES } from 'gisaima-shared/definitions/STRUCTURES.js';

const SIEGE_DECAY_RATE = 0.01;   // share of durability lost per besieged tick
const CRITICAL_SHARE   = 0.15;   // capture/collapse threshold (battleTick parity)
const NOTIFY_EVERY     = 10;     // chat update cadence, in besieged ticks

export function processSieges(worldId, ops, chunks, now) {
  let besieged = 0;

  for (const [chunkKey, tiles] of Object.entries(chunks || {})) {
    for (const [tileKey, tile] of Object.entries(tiles || {})) {
      const structure = tile?.structure;
      if (!structure || !structure.owner || structure.monster) continue;
      if (structure.type === 'spawn' || structure.type === 'ruins') continue;
      if (structure.status === 'building') continue;
      if (tile.battles && Object.keys(tile.battles).length) continue;

      const def = STRUCTURES[structure.type];
      const durability = def?.durability || 100;

      // Hostile player groups idle on the tile = besiegers.
      const besiegers = Object.values(tile.groups || {}).filter(g =>
        g && g.owner && g.owner !== structure.owner &&
        g.type !== 'monster' && g.status === 'idle' && !g.battleId
      );

      const path = `${tileKey}.structure`;
      const [x, y] = tileKey.split(',').map(Number);

      if (!besiegers.length) {
        // Siege lifted — reset the counter, keep the scars.
        if (structure.siegeTicks) ops.chunk(worldId, chunkKey, `${path}.siegeTicks`, null);
        continue;
      }

      besieged++;
      const siegeTicks = (structure.siegeTicks || 0) + 1;
      const health     = structure.health !== undefined ? structure.health : durability;
      const decay      = Math.max(1, Math.round(durability * SIEGE_DECAY_RATE));
      const newHealth  = Math.max(0, health - decay);
      const critical   = Math.floor(durability * CRITICAL_SHARE);
      const name       = structure.name || structure.type;

      if (newHealth > critical) {
        ops.chunk(worldId, chunkKey, `${path}.siegeTicks`, siegeTicks);
        ops.chunk(worldId, chunkKey, `${path}.health`, newHealth);
        if (siegeTicks === 1 || siegeTicks % NOTIFY_EVERY === 0) {
          ops.chat(worldId, {
            text: siegeTicks === 1
              ? `${name} at (${x}, ${y}) is under siege!`
              : `The siege of ${name} at (${x}, ${y}) grinds on — ${newHealth}/${durability} health remains.`,
            type: 'event', timestamp: now, location: { x, y }
          });
          ops.report(structure.owner, worldId, {
            type: 'structure_besieged',
            title: `${name} Under Siege`,
            summary: `${name} at (${x}, ${y}) is besieged (${newHealth}/${durability} health). Relieve it or lose it.`,
            location: { x, y },
          });
        }
        continue;
      }

      // The walls give way — capture by the strongest besieger.
      const capturer = besiegers.reduce((best, g) => {
        const n = Object.keys(g.units || {}).length;
        return !best || n > best.n ? { g, n } : best;
      }, null)?.g;

      const prevOwner = structure.owner;
      const prevOwnerName = structure.ownerName || prevOwner;

      if (capturer) {
        ops.chunk(worldId, chunkKey, `${path}.owner`, capturer.owner);
        ops.chunk(worldId, chunkKey, `${path}.ownerName`, capturer.ownerName || null);
        ops.chunk(worldId, chunkKey, `${path}.health`, Math.max(1, critical));
        ops.chunk(worldId, chunkKey, `${path}.siegeTicks`, null);
        ops.chunk(worldId, chunkKey, `${path}.recruitmentQueue`, null);
        ops.chat(worldId, {
          text: `${name} at (${x}, ${y}) has fallen after a long siege — captured by ${capturer.ownerName || 'a besieger'}!`,
          type: 'event', timestamp: now, location: { x, y }
        });
        ops.report(capturer.owner, worldId, {
          type: 'structure_captured',
          title: `Captured ${name}`,
          summary: `Your siege of ${name} at (${x}, ${y}) succeeded — it is yours, battered but standing.`,
          location: { x, y },
        });
        ops.report(prevOwner, worldId, {
          type: 'structure_lost',
          title: `${name} Has Fallen`,
          summary: `${name} at (${x}, ${y}) fell to ${capturer.ownerName || 'besiegers'} after a prolonged siege.`,
          location: { x, y },
        });
      } else {
        ops.chunk(worldId, chunkKey, `${path}.type`, 'ruins');
        ops.chunk(worldId, chunkKey, `${path}.owner`, null);
        ops.chunk(worldId, chunkKey, `${path}.siegeTicks`, null);
        ops.chunk(worldId, chunkKey, `${path}.health`, null);
        ops.chat(worldId, {
          text: `${name} at (${x}, ${y}) has crumbled into ruins under siege.`,
          type: 'event', timestamp: now, location: { x, y }
        });
        ops.report(prevOwner, worldId, {
          type: 'structure_lost',
          title: `${name} Destroyed`,
          summary: `${name} at (${x}, ${y}) crumbled into ruins after a prolonged siege.`,
          location: { x, y },
        });
      }
    }
  }

  return { besieged };
}

export default processSieges;
