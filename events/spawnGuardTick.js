/**
 * Spawn guardians — morality teeth.
 *
 * A spawn structure is sacred ground. When an "evil" player's group sits on a
 * spawn tile, the spawn musters a guard band that sets upon the intruder
 * (a normal battle, resolved by battleTick). This gives villainy a real cost
 * and composes with the morality + exclusion-zone systems already in place.
 */
import { scoresFor, EVIL_THRESHOLD } from '../db/morality.js';

// A pre-existing unit type so guards have real combat stats regardless of
// whether the newer shared units (royal_guard, etc.) have been released yet.
const GUARD_UNIT_TYPE = 'human_knight';
const GUARD_COUNT = 3;

export async function processSpawnGuards(worldId, chunks, ops, db) {
  if (!chunks) return { mustered: 0 };

  // Spawn tiles that host non-fighting player groups and have no active battle.
  const candidates = [];
  const owners = new Set();
  for (const [chunkKey, tiles] of Object.entries(chunks)) {
    for (const [tileKey, tile] of Object.entries(tiles || {})) {
      if (tile?.structure?.type !== 'spawn') continue;
      if (tile.battles && Object.keys(tile.battles).length) continue;
      if (!tile.groups) continue;
      const playerGroups = Object.values(tile.groups)
        .filter(g => g?.owner && g.owner !== 'monster' && g.status !== 'fighting' && g.id);
      if (!playerGroups.length) continue;
      for (const g of playerGroups) owners.add(g.owner);
      candidates.push({ chunkKey, tileKey, tile, playerGroups });
    }
  }
  if (!candidates.length) return { mustered: 0 };

  const scores = await scoresFor(db, worldId, [...owners]).catch(() => ({}));
  let mustered = 0;

  for (const { chunkKey, tileKey, tile, playerGroups } of candidates) {
    const villains = playerGroups.filter(g => (scores[g.owner] ?? 0) <= EVIL_THRESHOLD);
    if (!villains.length) continue;

    const [x, y] = tileKey.split(',').map(Number);
    const now = Date.now();
    const rand = Math.floor(Math.random() * 1e6);
    const battleId = `battle_${now}_${rand}`;
    const guardId  = `guard_${now}_${rand}`;

    // The mustered guard band — a real map group so combat maths apply.
    const guardUnits = {};
    for (let i = 0; i < GUARD_COUNT; i++) {
      const uid = `gu_${i}_${rand}`;
      guardUnits[uid] = { id: uid, type: GUARD_UNIT_TYPE };
    }
    const guardGroup = {
      id: guardId, owner: 'guardian', type: 'monster', race: 'guardian',
      name: 'Spawn Guardians', status: 'fighting', x, y, units: guardUnits,
      battleId, battleSide: 1, battleRole: 'attacker',
    };

    const battleData = {
      id: battleId, locationX: x, locationY: y, targetTypes: ['group'],
      side1: { groups: { [guardId]: { type: 'monster', race: 'guardian', units: guardUnits } }, name: 'Spawn Guardians' },
      side2: { groups: Object.fromEntries(villains.map(g => [g.id, { type: g.type || 'player', race: g.race || 'unknown', units: g.units || {} }])), name: 'Intruders' },
      tickCount: 0,
    };

    ops.chunk(worldId, chunkKey, `${tileKey}.battles.${battleId}`, battleData);
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${guardId}`, guardGroup);
    for (const g of villains) {
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${g.id}.battleId`,   battleId);
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${g.id}.battleSide`, 2);
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${g.id}.battleRole`, 'defender');
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${g.id}.status`,     'fighting');
      // Stop any in-flight movement/gathering so the battle holds them.
      if (g.status === 'moving') {
        for (const f of ['movementPath', 'pathIndex', 'moveStarted', 'moveSpeed', 'nextMoveTime'])
          ops.chunk(worldId, chunkKey, `${tileKey}.groups.${g.id}.${f}`, null);
      }
      if (g.status === 'gathering') {
        for (const f of ['gatheringBiome', 'gatheringTicksRemaining'])
          ops.chunk(worldId, chunkKey, `${tileKey}.groups.${g.id}.${f}`, null);
      }
    }
    ops.chat(worldId, {
      location: { x, y },
      text: `⚔️ Spawn guardians set upon trespassers at (${x}, ${y})!`,
      timestamp: now, type: 'event', category: 'player',
    });
    mustered++;
  }

  return { mustered };
}

export default processSpawnGuards;
