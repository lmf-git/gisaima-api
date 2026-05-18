/**
 * Caravans — physical delivery groups that walk goods between two map points.
 * Spawned when a trade is accepted (one for each direction).
 *
 *   group {
 *     id, type: 'caravan',
 *     items: { ... },                   // payload being carried
 *     owner: <originatorUid>,          // who owns the caravan (and protects it)
 *     delivery: {
 *       toUid:        <recipientUid>,  // who to deposit into
 *       toX, toY,                       // destination tile
 *       risk:         'safe' | 'caravan'// loss model
 *     },
 *     x, y, movementPath, pathIndex,
 *     moveStarted, moveSpeed, nextMoveTime, status: 'moving',
 *     name: 'Caravan from <originator>'
 *   }
 *
 * `spawn` writes a new caravan group at the origin tile via ops.
 * `deliver` is invoked from moveTick when a caravan reaches the end of its
 * path — it deposits the items into the recipient's sink and removes the
 * caravan group from its destination tile.
 */
import { ObjectId } from 'mongodb';
import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { TerrainGenerator } from 'gisaima-shared/map/noise.js';
import { merge } from 'gisaima-shared/economy/items.js';
import { pay } from './rewards.js';

const _terrainByWorld = new Map();
async function _terrainFor(db, worldId) {
  if (_terrainByWorld.has(worldId)) return _terrainByWorld.get(worldId);
  const w = await db.collection('worlds').findOne({ _id: worldId }, { projection: { 'info.seed': 1 } });
  const gen = new TerrainGenerator(w?.info?.seed ?? 1, 4_000);
  _terrainByWorld.set(worldId, gen);
  return gen;
}

function newGroupId() {
  return `caravan_${new ObjectId().toString()}`;
}

/**
 * Build a tile-by-tile path from (fromX,fromY) to (toX,toY), avoiding water
 * tiles by stepping orthogonally when the diagonal would land in water.
 * Falls back to the diagonal as a best-effort last resort (e.g. when both the
 * diagonal and both orthogonals are water — caravan walks through, treating
 * the trip as a coastal march).
 */
function buildPath(fromX, fromY, toX, toY, terrain) {
  const path = [{ x: fromX, y: fromY }];
  let x = fromX, y = fromY;
  const isWater = (cx, cy) => {
    if (!terrain) return false;
    try {
      const t = terrain.getTerrainData(cx, cy);
      return !!(t?.water);
    } catch { return false; }
  };

  let safety = Math.abs(toX - fromX) + Math.abs(toY - fromY) + 50;
  while ((x !== toX || y !== toY) && safety-- > 0) {
    const dx = Math.sign(toX - x);
    const dy = Math.sign(toY - y);

    // First preference: diagonal step.
    let nx = x + dx, ny = y + dy;
    if (dx !== 0 && dy !== 0 && isWater(nx, ny)) {
      // Try orthogonal alternatives.
      if (!isWater(x + dx, y)) {
        ny = y;
      } else if (!isWater(x, y + dy)) {
        nx = x;
      }
      // else accept the water diagonal as the best effort
    }
    if (dx === 0 || dy === 0) {
      nx = x + dx;
      ny = y + dy;
    }
    x = nx; y = ny;
    path.push({ x, y });
  }
  return path;
}

export async function spawn(db, ops, worldId, {
  fromX, fromY, toX, toY,
  items, ownerUid, toUid, risk = 'safe', tickMs = 60_000
}) {
  if (!Number.isFinite(fromX) || !Number.isFinite(fromY)) return null;
  if (!Number.isFinite(toX) || !Number.isFinite(toY)) return null;
  const terrain = await _terrainFor(db, worldId);
  const chunkKey = getChunkKey(fromX, fromY);
  const tileKey  = `${fromX},${fromY}`;
  const path = buildPath(fromX, fromY, toX, toY, terrain);
  const id = newGroupId();
  const now = Date.now();

  const group = {
    id,
    type: 'caravan',
    name: `Caravan from ${ownerUid?.slice(0, 6) || 'unknown'}`,
    owner: ownerUid || null,
    items: items || {},
    x: fromX, y: fromY,
    status: 'moving',
    movementPath: path,
    pathIndex: 0,
    moveStarted: now,
    moveSpeed: 1,
    nextMoveTime: now + tickMs,
    delivery: { toUid, toX, toY, risk, spawnedAt: now }
  };

  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${id}`, group);
  return { groupId: id, chunkKey, tileKey };
}

/**
 * Called from moveTick at end of path. Deposits the caravan's items into the
 * recipient's reward sink and removes the caravan group from the tile.
 *
 * Handles caravan risk: 10% chance under `risk === 'caravan'` that the load
 * is lost to the realm (goods sent to the world coffer instead).
 */
export async function deliver(db, ops, worldId, group, atChunkKey, atTileKey) {
  const { items = {}, delivery } = group || {};
  if (!delivery) return null;

  const intercepted = delivery.risk === 'caravan' && Math.random() < 0.1;
  if (intercepted) {
    // Caravan ambushed — items go to the world coffers.
    const total = Object.values(items).reduce((a, b) => a + (Number(b) || 0), 0);
    if (total > 0) {
      await db.collection('coffers').updateOne(
        { _id: worldId },
        { $inc: { gold: total } },
        { upsert: true }
      );
    }
    ops.chunk(worldId, atChunkKey, `${atTileKey}.groups.${group.id}`, null);
    return { intercepted, total };
  }

  const sink = await pay(db, ops, worldId, delivery.toUid, items);
  ops.chunk(worldId, atChunkKey, `${atTileKey}.groups.${group.id}`, null);
  return { intercepted, delivered: items, sink };
}
