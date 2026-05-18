/**
 * Game tick scheduler — replaces Firebase onSchedule.
 * Runs every 60 seconds, processing all world state.
 */

import { getDb } from '../db/connection.js';
import { loadAllWorlds } from '../db/worlds.js';
import { Ops } from '../lib/ops.js';
import { trimChatMessages } from '../db/chat.js';
import { broadcastChunkUpdate, broadcastWorldTick } from './ws.js';
import { updateWorldVisibility } from '../lib/visibility.js';
import { TerrainGenerator } from 'gisaima-shared/map/noise.js';

import { mergeWorldMonsterGroups, monsterSpawnTick, spawnMonsters } from '../events/monsterSpawnTick.js';
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
import { processStructureProduction }     from '../events/structureProductionTick.js';

const TICK_INTERVAL_MS = 60_000;
const MAX_CHAT_HISTORY = 500;

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
  const terrainGenerator = new TerrainGenerator(worldInfo.seed, 10_000);

  // Advance tick counter alongside lastTick so in-world time-of-day works.
  const prevTickCount = Number(worldInfo.tickCount) || 0;
  await db.collection('worlds').updateOne(
    { _id: worldId },
    {
      $set: { 'info.lastTick': now },
      $inc: { 'info.tickCount': 1 }
    },
    { upsert: true }
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
            if (processDemobilization(worldId, ops, group, chunkKey, tileKey, groupId, tile, now)) {
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

  await ops.flush(db);

  // Broadcast updated chunks to WebSocket clients
  await broadcastChangedChunks(db, worldId, ops);

  // --- Async processors (use worldData already loaded) ---
  await upgradeTickProcessor(worldId, worldData, db);
  await processCrafting(worldId, worldData, db);

  if (Math.random() < 0.666) await processMonsterStrategies(worldId, chunks, terrainGenerator, db);
  if (Math.random() < 0.2)   await spawnMonsters(worldId, chunks, terrainGenerator, db);
  if (Math.random() < 0.15)  await mergeWorldMonsterGroups(worldId, chunks, terrainGenerator, db);

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

  // Inactivity sweep — must run *after* battleTick has resolved so any
  // soon-to-be-purged player's pending battles are already on tiles. The
  // cleanup module skips anything currently locked in a battle, so live
  // state is never broken mid-resolution.
  try {
    const cleanupOps = new Ops();
    const r = await tickCleanup(db, worldId, chunks, cleanupOps, worldInfo);
    await cleanupOps.flush(db);
    if (r.degraded || r.ruined || r.removedGroups || r.removedStructures || r.removedPlayers) {
      console.log(`[tick] ${worldId} cleanup: degraded=${r.degraded} ruined=${r.ruined} groups=${r.removedGroups} structs=${r.removedStructures} players=${r.removedPlayers}`);
    }
  } catch (err) {
    console.error(`[tick] cleanup ${worldId}:`, err);
  }

  const updatedWorld = await db.collection('worlds').findOne({ _id: worldId }, { projection: { info: 1 } });
  broadcastWorldTick(worldId, updatedWorld?.info || worldInfo);
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
