/**
 * Game tick scheduler — replaces Firebase onSchedule.
 * Runs every 60 seconds, processing all world state.
 */

import { getDb } from '../db/connection.js';
import { loadAllWorlds } from '../db/worlds.js';
import { Ops } from '../lib/ops.js';
import { trimChatMessages } from '../db/chat.js';
import { broadcastChunkUpdate, broadcastWorldTick } from './ws.js';
import { updateWorldVisibility, refreshIfStale } from '../lib/visibility.js';
import { TerrainGenerator } from 'gisaima-shared/map/noise.js';

import { mergeWorldMonsterGroups, monsterSpawnTick, spawnMonsters } from '../events/monsterSpawnTick.js';
import { processStarvation }       from '../events/starvationTick.js';
import { processBattle }           from '../events/battleTick.js';
import { processMobilizations }    from '../events/mobiliseTick.js';
import { processDemobilization }   from '../events/demobiliseTick.js';
import { processMovement }         from '../events/moveTick.js';
import { processGathering }        from '../events/gatheringTick.js';
import { processBuilding }         from '../events/buildTick.js';
import { upgradeTickProcessor }    from '../events/upgradeTick.js';
import { processCrafting }         from '../events/craftingTick.js';
import { processMonsterStrategies }from '../events/monsterStrategyTick.js';
import { processRecruitment }      from '../events/recruitmentTick.js';

// New per-domain tick hooks
import { tickClosure as tickVoteClosure } from '../db/politics.js';
import { tick as tickBanks }              from '../db/banks.js';
import { progressTrails }                 from '../db/trails.js';
import { tick as tickCleanup }            from '../db/cleanup.js';
import { tick as tickMonsterPopulation }  from '../db/monsterCleanup.js';
import { processStructureProduction }     from '../events/structureProductionTick.js';

const TICK_INTERVAL_MS = 60_000;
const MAX_CHAT_HISTORY = 500;

// Walk the in-memory chunks once to count monster population. Growth in these
// numbers over a long-running world is the prime suspect for tick slowdown,
// so we log them alongside the per-phase timing breakdown.
function censusMonsters(chunks) {
  let groups = 0, units = 0, structures = 0, totalGroups = 0, totalTiles = 0;
  for (const chunkKey in chunks) {
    const chunk = chunks[chunkKey];
    for (const tileKey in chunk) {
      const tile = chunk[tileKey];
      totalTiles++;
      if (tile.structure?.monster === true) structures++;
      if (tile.groups) {
        for (const groupId in tile.groups) {
          const g = tile.groups[groupId];
          totalGroups++;
          if (g?.type === 'monster') {
            groups++;
            units += g.units ? Object.keys(g.units).length : 0;
          }
        }
      }
    }
  }
  return { groups, units, structures, totalGroups, totalTiles };
}

export function startTick() {
  console.log('Game tick scheduler started');
  runTick().catch(err => console.error('Tick error:', err));
  setInterval(() => {
    runTick().catch(err => console.error('Tick error:', err));
  }, TICK_INTERVAL_MS);
}

async function runTick() {
  const db  = getDb();
  const now = Date.now();
  console.log(`[tick] ${new Date(now).toISOString()}`);

  const worlds = await loadAllWorlds(db);
  if (!worlds || !Object.keys(worlds).length) {
    console.log('[tick] no worlds');
    return;
  }

  for (const worldId in worlds) {
    try {
      await processWorld(db, worldId, worlds[worldId], now);
    } catch (err) {
      console.error(`[tick] world ${worldId} error:`, err);
    }
  }
}

async function processWorld(db, worldId, worldData, now) {
  const worldInfo = worldData?.info || {};
  if (worldInfo.seed === undefined || worldInfo.seed === null || worldInfo.seed === '') {
    console.error(`[tick] world ${worldId} skipped: info.seed is missing (re-seed/restore this world)`);
    return;
  }
  const terrainGenerator = new TerrainGenerator(worldInfo.seed, 10_000);

  // Advance tick counter alongside lastTick so in-world time-of-day works.
  // upsert:false so the tick never fabricates a seedless world doc — worlds are
  // created only by the seed/restore path, never here.
  const prevTickCount = Number(worldInfo.tickCount) || 0;
  await db.collection('worlds').updateOne(
    { _id: worldId },
    {
      $set: { 'info.lastTick': now },
      $inc: { 'info.tickCount': 1 }
    },
    { upsert: false }
  );
  worldInfo.tickCount = prevTickCount + 1;

  const removed = await trimChatMessages(db, worldId, MAX_CHAT_HISTORY);
  if (removed > 0) console.log(`[tick] removed ${removed} old chat messages in ${worldId}`);

  const chunks = worldData.chunks || {};
  if (!Object.keys(chunks).length) return;

  // Pull morality scores so the beacon visibility extension can downgrade
  // privacy for low-morality players (bad acts → wider visibility).
  const moralityByUid = {};
  try {
    const playerDocs = await db.collection('players')
      .find({ [`worlds.${worldId}.morality`]: { $exists: true } },
            { projection: { _id: 1, [`worlds.${worldId}.morality.score`]: 1 } })
      .toArray();
    for (const p of playerDocs) {
      const s = p.worlds?.[worldId]?.morality?.score;
      if (typeof s === 'number') moralityByUid[p._id] = s;
    }
  } catch (err) {
    console.error(`[tick] morality fetch ${worldId}:`, err);
  }
  updateWorldVisibility(worldId, chunks, moralityByUid);

  const ops = new Ops();
  const processedGroups = new Set();

  // Per-phase timing: mark(label) records elapsed since the previous mark.
  const timings = {};
  let _t = Date.now();
  const mark = (label) => { timings[label] = (timings[label] || 0) + (Date.now() - _t); _t = Date.now(); };

  // --- Pass 0: starvation (settle hunger before anything else so a unit can
  // never starve mid-battle in the same tick that resolves that battle) ---
  processStarvation(worldId, ops, chunks, now);
  mark('starvation');

  // --- Pass 1: battles (must resolve before movement / mobilisation) ---
  for (const chunkKey in chunks) {
    const chunk = chunks[chunkKey];
    for (const tileKey in chunk) {
      const tile = chunk[tileKey];
      if (!tile.battles) continue;
      for (const battleId in tile.battles) {
        const battle = tile.battles[battleId];
        if (!battle) continue;
        await processBattle(worldId, chunkKey, tileKey, battleId, battle, ops, tile);
        for (const side of ['side1', 'side2']) {
          if (battle[side]?.groups) {
            Object.keys(battle[side].groups).forEach(gid =>
              processedGroups.add(`${chunkKey}_${tileKey}_${gid}`)
            );
          }
        }
      }
    }
  }

  mark('battles');

  // --- Pass 2: group activities ---
  for (const chunkKey in chunks) {
    const chunk = chunks[chunkKey];
    for (const tileKey in chunk) {
      const tile = chunk[tileKey];

      if (tile.structure?.status === 'building') {
        await processBuilding(worldId, ops, chunkKey, tileKey, tile, now);
      }

      if (tile.structure?.recruitmentQueue) {
        processRecruitment(worldId, ops, chunkKey, tileKey, tile, now);
      }

      if (!tile.groups) continue;

      processMobilizations(worldId, ops, tile.groups, chunkKey, tileKey, now, worldInfo.lastTick);

      for (const groupId in tile.groups) {
        const group = tile.groups[groupId];
        const key   = `${chunkKey}_${tileKey}_${groupId}`;
        if (processedGroups.has(key)) continue;

        switch (group.status) {
          case 'demobilising':
            if (await processDemobilization(worldId, ops, group, chunkKey, tileKey, groupId, tile, now, db)) {
              processedGroups.add(key);
            }
            break;
          case 'moving':
            if (await processMovement(worldId, ops, group, chunkKey, tileKey, groupId, now, db, worldInfo)) {
              processedGroups.add(key);
            }
            break;
          case 'gathering':
            if (processGathering(worldId, ops, group, chunkKey, tileKey, groupId, tile, now, terrainGenerator)) {
              processedGroups.add(key);
            }
            break;
        }
      }
    }
  }

  mark('groupActivities');

  await ops.flush(db);
  mark('flush');

  // Rebuild visibility from post-flush state so broadcast filtering reflects
  // any movements/spawns that happened during this tick rather than the
  // start-of-tick positions.
  await refreshIfStale(db, worldId, 0);
  mark('visibility');

  // Broadcast updated chunks to WebSocket clients
  await broadcastChangedChunks(db, worldId, ops);
  mark('broadcast');

  // --- Async processors (use worldData already loaded) ---
  await upgradeTickProcessor(worldId, worldData, db);
  mark('upgrades');
  await processCrafting(worldId, worldData, db);
  mark('crafting');

  if (Math.random() < 0.666) await processMonsterStrategies(worldId, chunks, terrainGenerator, db);
  mark('monsterStrategies');
  if (Math.random() < 0.2)   await spawnMonsters(worldId, chunks, terrainGenerator, db);
  mark('spawnMonsters');
  if (Math.random() < 0.15)  await mergeWorldMonsterGroups(worldId, chunks, terrainGenerator, db);
  mark('mergeMonsters');

  // --- Structure passive production + tax skim ---
  try {
    const prodOps = new Ops();
    const r = await processStructureProduction(db, worldId, chunks, prodOps);
    await prodOps.flush(db);
    if (r.producedStructures > 0 || r.totalTaxed > 0) {
      console.log(`[tick] ${worldId} production: ${r.producedStructures} structures · ${r.totalTaxed} gold to coffers`);
    }
  } catch (err) {
    console.error(`[tick] structureProduction ${worldId}:`, err);
  }
  mark('structureProduction');

  // --- Per-domain tick hooks (politics, banks, trails) ---
  try {
    const closed = await tickVoteClosure(db, worldId, new Date(now));
    if (closed > 0) console.log(`[tick] ${worldId} closed ${closed} expired votes`);
  } catch (err) {
    console.error(`[tick] vote closure ${worldId}:`, err);
  }
  try {
    const bankResult = await tickBanks(db, worldId);
    if (bankResult.defaults > 0) console.log(`[tick] ${worldId} ${bankResult.defaults} loan defaults`);
  } catch (err) {
    console.error(`[tick] banks ${worldId}:`, err);
  }
  try {
    const trailsCompleted = await progressTrails(db, worldId);
    if (trailsCompleted > 0) console.log(`[tick] ${worldId} ${trailsCompleted} treasure trail(s) completed`);
  } catch (err) {
    console.error(`[tick] trails ${worldId}:`, err);
  }
  mark('domainHooks');

  // Inactivity sweep — must run *after* battleTick has resolved so any
  // soon-to-be-purged player's pending battles are already on tiles. The
  // cleanup module skips anything currently locked in a battle, so live
  // state is never broken mid-resolution.
  try {
    const cleanupOps = new Ops();
    const r = await tickCleanup(db, worldId, chunks, cleanupOps, worldInfo);
    await cleanupOps.flush(db);
    if (r.degraded || r.ruined || r.removedGroups || r.removedStructures || r.removedPlayers || r.removedAccounts) {
      console.log(`[tick] ${worldId} cleanup: degraded=${r.degraded} ruined=${r.ruined} groups=${r.removedGroups} structs=${r.removedStructures} players=${r.removedPlayers} guestAccounts=${r.removedAccounts}`);
    }
  } catch (err) {
    console.error(`[tick] cleanup ${worldId}:`, err);
  }
  mark('cleanup');

  // --- Monster population control (cap by active players + aging) ---
  // Reads fresh chunk state and runs last so it never removes a monster that
  // entered a battle or began demobilising during this tick. Gated to amortise
  // the extra chunk read — population drifts slowly, no need to check it every
  // tick.
  if (Math.random() < 0.25) {
    try {
      const mcOps = new Ops();
      const r = await tickMonsterPopulation(db, worldId, mcOps, worldInfo);
      await mcOps.flush(db);
      if (r.agedGroups || r.cappedGroups || r.agedStructs || r.cappedStructs) {
        console.log(`[tick] ${worldId} monsterCap (players=${r.activePlayers} caps g=${r.groupCap}/s=${r.structCap}; ` +
                    `had g=${r.monsterGroups}/s=${r.monsterStructs}) removed groups aged=${r.agedGroups} ` +
                    `capped=${r.cappedGroups} · structs aged=${r.agedStructs} capped=${r.cappedStructs}`);
      }
    } catch (err) {
      console.error(`[tick] monsterCap ${worldId}:`, err);
    }
  }
  mark('monsterCap');

  const updatedWorld = await db.collection('worlds').findOne({ _id: worldId }, { projection: { info: 1 } });
  broadcastWorldTick(worldId, updatedWorld?.info || worldInfo);

  // --- Per-phase timing breakdown + monster census ---
  const total = Object.values(timings).reduce((a, b) => a + b, 0);
  const breakdown = Object.entries(timings)
    .sort((a, b) => b[1] - a[1])
    .map(([label, ms]) => `${label}=${ms}ms`)
    .join(' ');
  const m = censusMonsters(chunks);
  console.log(`[tick] ${worldId} timing ${total}ms · ${breakdown}`);
  console.log(`[tick] ${worldId} census · monsterGroups=${m.groups} monsterUnits=${m.units} ` +
              `monsterStructs=${m.structures} | totalGroups=${m.totalGroups} tiles=${m.totalTiles}`);
}

async function broadcastChangedChunks(db, worldId, ops) {
  const changedChunks = new Set();
  for (const { worldId: wId, chunkKey } of ops._chunks.values()) {
    if (wId === worldId) changedChunks.add(chunkKey);
  }
  for (const chunkKey of changedChunks) {
    const doc = await db.collection('chunks').findOne({ worldId, chunkKey });
    if (doc) broadcastChunkUpdate(worldId, chunkKey, doc.tiles || {});
  }
}
