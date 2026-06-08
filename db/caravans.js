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
import { getFor as getMorality, moralityAmbushChance } from './morality.js';
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

// Naval route: a ship sails the straight line between ports, crossing water
// freely (unlike the land caravan, which steps around it).
function buildDirectPath(fromX, fromY, toX, toY) {
  const path = [{ x: fromX, y: fromY }];
  let x = fromX, y = fromY;
  let safety = Math.abs(toX - fromX) + Math.abs(toY - fromY) + 50;
  while ((x !== toX || y !== toY) && safety-- > 0) {
    x += Math.sign(toX - x);
    y += Math.sign(toY - y);
    path.push({ x, y });
  }
  return path;
}

export async function spawn(db, ops, worldId, {
  fromX, fromY, toX, toY,
  items, ownerUid, toUid, risk = 'safe', tickMs = 60_000, mode = 'land', crew = null
}) {
  if (!Number.isFinite(fromX) || !Number.isFinite(fromY)) return null;
  if (!Number.isFinite(toX) || !Number.isFinite(toY)) return null;
  const naval = mode === 'naval';
  const terrain = naval ? null : await _terrainFor(db, worldId);
  const chunkKey = getChunkKey(fromX, fromY);
  const tileKey  = `${fromX},${fromY}`;
  // Ships sail direct over water; caravans route around it.
  const path = naval
    ? buildDirectPath(fromX, fromY, toX, toY)
    : buildPath(fromX, fromY, toX, toY, terrain);
  const id = newGroupId();
  const now = Date.now();

  const group = {
    id,
    type: 'caravan',
    mode: naval ? 'naval' : 'land',
    name: `${naval ? 'Trade ship' : 'Caravan'} from ${ownerUid?.slice(0, 6) || 'unknown'}`,
    owner: ownerUid || null,
    items: items || {},
    x: fromX, y: fromY,
    status: 'moving',
    movementPath: path,
    pathIndex: 0,
    moveStarted: now,
    moveSpeed: 1,
    nextMoveTime: now + tickMs,
    ...(crew ? { crew } : {}),
    delivery: { toUid, toX, toY, risk, spawnedAt: now }
  };

  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${id}`, group);
  return { groupId: id, chunkKey, tileKey, mode: group.mode };
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

  // Ambush risk scales with the caravan owner's morality — villains are preyed
  // upon, saints sheltered.
  let ambushChance = 0.1;
  if (delivery.risk === 'caravan' && group.owner && group.owner !== 'monster') {
    const score = (await getMorality(db, worldId, group.owner).catch(() => null))?.score ?? 0;
    ambushChance = moralityAmbushChance(score, 0.1);
  }
  const intercepted = delivery.risk === 'caravan' && Math.random() < ambushChance;
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

  // Prefer depositing straight into the structure standing on the arrival tile
  // — that's the destination of a structure-to-structure trade route. Fall back
  // to the recipient's resolved sink (home/current structure) when the arrival
  // tile has no structure.
  const arrivalChunk = await db.collection('chunks').findOne(
    { worldId, chunkKey: atChunkKey },
    { projection: { [`tiles.${atTileKey}.structure`]: 1 } }
  );
  const destStructure = arrivalChunk?.tiles?.[atTileKey]?.structure;

  let sink;
  if (destStructure) {
    sink = { kind: 'structure', tileKey: atTileKey, chunkKey: atChunkKey };
    ops.chunk(worldId, atChunkKey, `${atTileKey}.structure.items`, merge(destStructure.items || {}, items));
    // The crew disembarks into the destination garrison.
    if (group.crew) _garrisonCrew(ops, worldId, atChunkKey, atTileKey, destStructure, group.crew);
  } else {
    sink = await pay(db, ops, worldId, delivery.toUid, items);
  }
  ops.chunk(worldId, atChunkKey, `${atTileKey}.groups.${group.id}`, null);
  return { intercepted, delivered: items, sink };
}

// Add a shipment's crew unit into a structure's garrison, merging into an
// existing stack of the same unit type when present.
function _garrisonCrew(ops, worldId, chunkKey, tileKey, structure, crew) {
  const units = structure?.units;
  const add = Number(crew.quantity) || 1;
  if (Array.isArray(units)) {
    ops.chunk(worldId, chunkKey, `${tileKey}.structure.units.${units.length}`, { ...crew });
    return;
  }
  const obj = units || {};
  const existingKey = Object.keys(obj).find(k => obj[k]?.unitId === crew.unitId && obj[k]?.owner === crew.owner);
  if (existingKey) {
    ops.chunk(worldId, chunkKey, `${tileKey}.structure.units.${existingKey}.quantity`, (Number(obj[existingKey].quantity) || 0) + add);
  } else {
    ops.chunk(worldId, chunkKey, `${tileKey}.structure.units.${crew.unitId || crew.id}`, { ...crew });
  }
}
