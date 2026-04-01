/**
 * Game tick scheduler — replaces Firebase onSchedule.
 * Runs every 60 seconds, processing all world state.
 */

import { getDb } from '../db/connection.js';
import { loadAllWorlds } from '../db/worlds.js';
import { applyUpdates } from '../db/adapter.js';
import { trimChatMessages } from '../db/chat.js';
import { broadcastChunkUpdate, broadcastWorldTick } from './ws.js';
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

const TICK_INTERVAL_MS = 60_000;
const MAX_CHAT_HISTORY = 500;

export function startTick() {
  console.log('Game tick scheduler started');
  // Run immediately then on interval
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

  // Update lastTick timestamp directly (not via updates object)
  await db.collection('worlds').updateOne(
    { _id: worldId },
    { $set: { 'info.lastTick': now } },
    { upsert: true }
  );

  // Chat cleanup
  const removed = await trimChatMessages(db, worldId, MAX_CHAT_HISTORY);
  if (removed > 0) console.log(`[tick] removed ${removed} old chat messages in ${worldId}`);

  const chunks = worldData.chunks || {};
  if (!Object.keys(chunks).length) return;

  // Flat updates object (Firebase-path style) — existing handlers write into this
  const updates = {};
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
        await processBattle(worldId, chunkKey, tileKey, battleId, battle, updates, tile);
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

      // Building construction
      if (tile.structure?.status === 'building') {
        await processBuilding(worldId, updates, chunkKey, tileKey, tile, now);
      }

      // Recruitment queue (per-tile helper)
      if (tile.structure?.recruitmentQueue) {
        processRecruitment(worldId, updates, chunkKey, tileKey, tile, now);
      }

      if (!tile.groups) continue;

      processMobilizations(worldId, updates, tile.groups, chunkKey, tileKey, now);

      for (const groupId in tile.groups) {
        const group = tile.groups[groupId];
        const key   = `${chunkKey}_${tileKey}_${groupId}`;
        if (processedGroups.has(key)) continue;

        switch (group.status) {
          case 'demobilising':
            if (processDemobilization(worldId, updates, group, chunkKey, tileKey, groupId, tile, now)) {
              processedGroups.add(key);
            }
            break;
          case 'moving':
            if (await processMovement(worldId, updates, group, chunkKey, tileKey, groupId, now, db, worldInfo)) {
              processedGroups.add(key);
            }
            break;
          case 'gathering':
            if (processGathering(worldId, updates, group, chunkKey, tileKey, groupId, tile, now, terrainGenerator)) {
              processedGroups.add(key);
            }
            break;
        }
      }
    }
  }

  // Apply batch updates
  if (Object.keys(updates).length) {
    const sanitised = sanitiseStatusUpdates(updates);
    await applyUpdates(db, sanitised);
  }

  // Broadcast updated chunks to WebSocket clients
  await broadcastChangedChunks(db, worldId, updates);

  // --- Async processors (use worldData already loaded) ---
  await upgradeTickProcessor(worldId, worldData, db);
  await processCrafting(worldId, worldData, db);

  if (Math.random() < 0.666) await processMonsterStrategies(worldId, chunks, terrainGenerator, db);
  if (Math.random() < 0.2)   await spawnMonsters(worldId, chunks, terrainGenerator, db);
  if (Math.random() < 0.15)  await mergeWorldMonsterGroups(worldId, chunks, terrainGenerator, db);

  // Broadcast world tick info
  const updatedWorld = await db.collection('worlds').findOne({ _id: worldId }, { projection: { info: 1 } });
  broadcastWorldTick(worldId, updatedWorld?.info || worldInfo);
}

/**
 * Find which chunks were touched by the updates object and broadcast their
 * fresh tile data to subscribed WebSocket clients.
 */
async function broadcastChangedChunks(db, worldId, updates) {
  const changedChunks = new Set();
  for (const path of Object.keys(updates)) {
    const parts = path.split('/');
    // worlds/{worldId}/chunks/{chunkKey}/...
    if (parts[0] === 'worlds' && parts[1] === worldId && parts[2] === 'chunks' && parts[3]) {
      changedChunks.add(parts[3]);
    }
  }
  for (const chunkKey of changedChunks) {
    const doc = await db.collection('chunks').findOne({ worldId, chunkKey });
    if (doc) broadcastChunkUpdate(worldId, chunkKey, doc.tiles || {});
  }
}

/**
 * Prevent conflicting status updates on the same group within one tick.
 * If a group gets both 'moving' and 'idle', keep 'idle' (demobilisation wins).
 */
function sanitiseStatusUpdates(updates) {
  const statusUpdates = {};
  for (const [path, value] of Object.entries(updates)) {
    if (path.endsWith('/status')) {
      if (statusUpdates[path] !== undefined && statusUpdates[path] !== value) {
        // Prefer terminal states
        const priority = { idle: 3, fighting: 2, moving: 1, mobilizing: 0 };
        if ((priority[value] ?? -1) <= (priority[statusUpdates[path]] ?? -1)) continue;
      }
      statusUpdates[path] = value;
    }
  }
  return { ...updates, ...statusUpdates };
}
