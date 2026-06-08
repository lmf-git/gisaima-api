/**
 * Game tick scheduler — replaces Firebase onSchedule.
 * Runs every 60 seconds, processing all world state.
 */

import { getDb } from '../db/connection.js';
import { loadAllWorlds } from '../db/worlds.js';
import { hasLiveWork, hasAnyContent, isTileHusk } from '../db/chunks.js';
import { recordWorldTick, recordRun, storageReport } from './metrics.js';
import { Ops } from '../lib/ops.js';
import { trimChatMessages } from '../db/chat.js';
import { broadcastChunkUpdate, broadcastWorldTick } from './ws.js';
import { refreshIfStale } from '../lib/visibility.js';
import { TerrainGenerator } from 'gisaima-shared/map/noise.js';
import { isNight } from 'gisaima-shared/time/era.js';

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
import { processResearch }         from '../events/researchTick.js';
import { processSpawnGuards }       from '../events/spawnGuardTick.js';
import { processMonsterStrategies }from '../events/monsterStrategyTick.js';
import { processRecruitment }      from '../events/recruitmentTick.js';

// New per-domain tick hooks
import { tickClosure as tickVoteClosure } from '../db/politics.js';
import { tick as tickBanks }              from '../db/banks.js';
import { progressTrails }                 from '../db/trails.js';
import { tickTradeRoutes }                 from '../db/tradeRoutes.js';
import { tick as tickCleanup }            from '../db/cleanup.js';
import { tick as tickMonsterPopulation }  from '../db/monsterCleanup.js';
import { processStructureProduction }     from '../events/structureProductionTick.js';

// Target spacing between tick *starts*. The tick self-schedules (see startTick)
// and adapts: a tick that runs long pushes the next one out rather than stacking,
// and we always leave at least TICK_MIN_GAP_MS idle for HTTP/WS to breathe on the
// shared dyno. In-world time is driven by tickCount, so a slightly variable real
// interval is fine. Both are env-overridable.
const TICK_INTERVAL_MS = Number(process.env.TICK_INTERVAL_MS) || 60_000;
const TICK_MIN_GAP_MS  = Number(process.env.TICK_MIN_GAP_MS)  || 5_000;
const MAX_CHAT_HISTORY = 500;

// Every Nth run, load *all* chunks (not just active ones) so the reconcile pass
// can demote chunks that fell idle without the tick touching them (e.g. a player
// route emptied a tile between ticks). Between sweeps, demotion still happens for
// any chunk the tick itself changed, so this is only a slow-drift backstop.
const FULL_SWEEP_EVERY = 30;

// Guard against overlap if a tick somehow runs past its own scheduling.
let _ticking  = false;
let _runCount = 0;

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

let _timeoutId = null;
let _stopped   = false;

export function startTick() {
  console.log(`Game tick scheduler started (target ${TICK_INTERVAL_MS}ms, min gap ${TICK_MIN_GAP_MS}ms)`);
  _stopped = false;
  _scheduleNext(0);
}

// Self-scheduling loop: run a tick, then schedule the next so starts are ~target
// apart when ticks are fast, but a long tick just delays the next one (back-off)
// while still guaranteeing TICK_MIN_GAP_MS of idle for request handling.
function _scheduleNext(delay) {
  if (_stopped) return;
  _timeoutId = setTimeout(async () => {
    const started = Date.now();
    try { await runTick(); } catch (err) { console.error('Tick error:', err); }
    const elapsed = Date.now() - started;
    const next = Math.max(TICK_MIN_GAP_MS, TICK_INTERVAL_MS - elapsed);
    if (elapsed > TICK_INTERVAL_MS) {
      console.warn(`[tick] overran target (${elapsed}ms > ${TICK_INTERVAL_MS}ms) — next in ${next}ms`);
    }
    _scheduleNext(next);
  }, delay);
}

/**
 * Stop scheduling new ticks and wait (briefly) for an in-flight tick to finish,
 * so a Heroku dyno cycle (SIGTERM) doesn't kill the process mid-write.
 */
export async function stopTick({ drainMs = 8000 } = {}) {
  _stopped = true;
  if (_timeoutId) { clearTimeout(_timeoutId); _timeoutId = null; }
  const deadline = Date.now() + drainMs;
  while (_ticking && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
  }
}

async function runTick() {
  if (_ticking) {
    console.warn('[tick] previous tick still running — skipping this interval');
    return;
  }
  _ticking = true;
  const runStart = Date.now();
  try {
    const db        = getDb();
    const now       = runStart;
    const fullSweep = (_runCount++ % FULL_SWEEP_EVERY) === 0;
    console.log(`[tick] ${new Date(now).toISOString()}${fullSweep ? ' (full sweep)' : ''}`);

    const worlds = await loadAllWorlds(db, { activeOnly: !fullSweep });
    if (!worlds || !Object.keys(worlds).length) {
      console.log('[tick] no worlds');
      return;
    }

    // Worlds are independent — process them concurrently so overall tick latency
    // is the slowest world, not the sum of all of them.
    await Promise.all(Object.keys(worlds).map(worldId =>
      processWorld(db, worldId, worlds[worldId], now, fullSweep)
        .catch(err => console.error(`[tick] world ${worldId} error:`, err))
    ));

    // Log the storage trend once per full sweep (~every 30 min) so it shows up
    // in Heroku logs without polling /metrics. The 512MB M0 cap is the wall.
    if (fullSweep) {
      const s = await storageReport(db);
      if (!s.error) {
        console.log(`[tick] storage ${s.storageMB}MB / ${s.capMB}MB (${s.usedPct}%) · data ${s.dataMB}MB · index ${s.indexMB}MB`);
      }
    }
  } finally {
    _ticking = false;
    const totalMs = Date.now() - runStart;
    recordRun({ totalMs, slow: totalMs > TICK_INTERVAL_MS });
  }
}

async function processWorld(db, worldId, worldData, now, fullSweep = false) {
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

  // Visibility is (re)built post-flush by refreshIfStale(0) below, which is the
  // copy every broadcast in this tick actually reads; concurrent chunk requests
  // keep it fresh on their own path. So we deliberately do NOT build it here from
  // start-of-tick state — that would be an immediately-stale extra morality query
  // and visibility pass per world, per tick.

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
        await processBattle(worldId, chunkKey, tileKey, battleId, battle, ops, tile, worldInfo);
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

  // Broadcast updated chunks to WebSocket clients, and reconcile the `active`
  // flag from post-flush state (this is where idle chunks get demoted).
  const reclaim = await broadcastAndReconcile(db, worldId, ops, chunks, fullSweep);
  mark('broadcast');

  // --- Async processors (use worldData already loaded) ---
  await upgradeTickProcessor(worldId, worldData, db);
  mark('upgrades');
  await processCrafting(worldId, worldData, db);
  mark('crafting');
  await processResearch(worldId, worldData, db);
  mark('research');
  // Spawn guardians muster against evil intruders on spawn tiles (battle resolves
  // next tick). Uses post-flush chunk state via a fresh ops batch.
  try {
    const guardOps = new Ops();
    const gr = await processSpawnGuards(worldId, chunks, guardOps, db);
    await guardOps.flush(db);
    if (gr.mustered > 0) console.log(`[tick] ${worldId} spawn guardians mustered: ${gr.mustered}`);
  } catch (err) {
    console.error(`[tick] spawnGuards ${worldId}:`, err);
  }
  mark('spawnGuards');

  // Nocturnal surge: monsters roam and spawn more aggressively at night so the
  // day/night clock has real teeth rather than being a cosmetic tint.
  const night = isNight(worldInfo.tickCount);
  const strategyChance = night ? 0.85 : 0.666;
  const spawnChance    = night ? 0.4  : 0.2;
  if (Math.random() < strategyChance) await processMonsterStrategies(worldId, chunks, terrainGenerator, db);
  mark('monsterStrategies');
  if (Math.random() < spawnChance)    await spawnMonsters(worldId, chunks, terrainGenerator, db);
  mark('spawnMonsters');
  if (Math.random() < 0.15)  await mergeWorldMonsterGroups(worldId, chunks, terrainGenerator, db);
  mark('mergeMonsters');

  // --- Structure passive production + tax skim ---
  try {
    const prodOps = new Ops();
    // A passed Festival proposal (governance) boosts passive production for a
    // time — this is the visible payoff that closes the tax → coffers → vote →
    // spend loop.
    const festivalActive = Number(worldInfo.festivalUntil) > now;
    const productionMultiplier = festivalActive ? 1.5 : 1;
    const r = await processStructureProduction(db, worldId, chunks, prodOps, worldInfo.tickCount, productionMultiplier);
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
  try {
    const shipped = await tickTradeRoutes(db, worldId);
    if (shipped > 0) console.log(`[tick] ${worldId} ${shipped} auto trade shipment(s) dispatched`);
  } catch (err) {
    console.error(`[tick] trade routes ${worldId}:`, err);
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
  console.log(`[tick] ${worldId} timing ${total}ms · ${breakdown}`);
  recordWorldTick(worldId, {
    durationMs:   total,
    activeChunks: Object.keys(chunks).length,
    deleted:      reclaim?.deleted || 0,
    pruned:       reclaim?.pruned  || 0,
  });
  if (total > TICK_INTERVAL_MS * 0.8) {
    console.warn(`[tick] ${worldId} SLOW: ${total}ms is >80% of the ${TICK_INTERVAL_MS}ms interval — ` +
                 `worst phase ${Object.entries(timings).sort((a, b) => b[1] - a[1])[0]?.join('=')}`);
  }
  // Census walks every tile, so only run it on full-sweep ticks (when every
  // chunk is already loaded anyway) — it is diagnostics, not game logic.
  if (fullSweep) {
    const m = censusMonsters(chunks);
    console.log(`[tick] ${worldId} census · monsterGroups=${m.groups} monsterUnits=${m.units} ` +
                `monsterStructs=${m.structures} | totalGroups=${m.totalGroups} tiles=${m.totalTiles}`);
  }
}

// Broadcast chunks mutated this tick and reconcile their `active` flag from the
// authoritative post-flush state. A single $in read replaces the old N+1 of one
// findOne per changed chunk. Demotion (active:false) lives here because this is
// the only place we hold true whole-chunk state after writes have landed.
//
// On a full sweep every loaded chunk is checked for demotion (catches chunks
// that fell idle via a player route without the tick touching them); normal
// ticks only check the chunks they changed.
async function broadcastAndReconcile(db, worldId, ops, chunks, fullSweep) {
  const changedChunks = new Set();
  for (const { worldId: wId, chunkKey } of ops._chunks.values()) {
    if (wId === worldId) changedChunks.add(chunkKey);
  }

  // Fetch fresh post-flush state for changed chunks in one round-trip.
  const freshTiles = new Map(); // chunkKey → tiles
  if (changedChunks.size) {
    const docs = await db.collection('chunks')
      .find({ worldId, chunkKey: { $in: [...changedChunks] } })
      .toArray();
    for (const doc of docs) {
      const tiles = doc.tiles || {};
      freshTiles.set(doc.chunkKey, tiles);
      broadcastChunkUpdate(worldId, doc.chunkKey, tiles);
    }
  }

  // Reconcile each chunk from authoritative post-flush state. Three outcomes:
  //   • no content at all  → delete the doc (pure terrain, regenerates from the
  //     world seed on next visit) to reclaim free-tier storage;
  //   • content but no work (e.g. ground items only) → demote to active:false;
  //   • live work → leave active (Ops already promoted it).
  // Changed chunks use the fresh read; on a full sweep, unchanged chunks use the
  // in-memory state we loaded (equal to their DB state — nothing wrote to them).
  //
  // Deleting an emptied chunk is safe against a concurrent player write: every
  // chunk write upserts (lib/ops.js), so a racing action simply recreates the
  // doc with its content. The common emptying case — the tick moving a group
  // out — has no racer, since the tick owns that group's processing.
  const writes = [];
  let deleted = 0, pruned = 0;
  const consider = fullSweep ? new Set([...Object.keys(chunks), ...changedChunks]) : changedChunks;
  for (const chunkKey of consider) {
    const tiles = freshTiles.get(chunkKey) ?? chunks[chunkKey];
    if (!tiles) continue;
    if (!hasAnyContent(tiles)) {
      writes.push({ deleteOne: { filter: { worldId, chunkKey } } });
      deleted++;
      continue;
    }
    // Chunk is kept. Strip any husk tiles ({groups:{}} etc. left behind when the
    // last entity moved out) so empty tile objects don't accumulate in the doc.
    const update = hasLiveWork(tiles) ? {} : { $set: { active: false } };
    const $unset = {};
    for (const tileKey in tiles) {
      if (isTileHusk(tiles[tileKey])) { $unset[`tiles.${tileKey}`] = ''; pruned++; }
    }
    if (Object.keys($unset).length) update.$unset = $unset;
    if (Object.keys(update).length) {
      writes.push({ updateOne: { filter: { worldId, chunkKey }, update } });
    }
  }
  if (writes.length) await db.collection('chunks').bulkWrite(writes, { ordered: false });
  if (deleted || pruned) {
    console.log(`[tick] ${worldId} storage reclaim · deleted ${deleted} chunk(s), pruned ${pruned} husk tile(s)`);
  }
  return { deleted, pruned };
}
