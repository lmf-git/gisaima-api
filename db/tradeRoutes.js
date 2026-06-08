// Trade routes — structure-to-structure shipping lanes. A route always runs
// between two structures; the goods are physically shipped by a land caravan or
// a naval vessel (chosen from whether the origin structure has a harbour) that
// moves across the map via the normal movement tick.
//
// Goods are LOCKED at the origin structure the moment a shipment departs: the
// items are deducted from the structure's store and loaded onto the group. A
// route with `autoship` set dispatches a fresh shipment every tick while the
// origin can still cover the manifest.
//
// Schema (`trade_routes`):
//   _id, worldId, ownerUid, ownerName,
//   fromX, fromY, toX, toY, toUid, toName,
//   items: { CODE: qty }, mode: 'land'|'naval',
//   autoship: bool, template: bool,
//   status: 'active'|'archived',
//   createdAt, lastRunAt, runCount

import { ObjectId } from 'mongodb';
import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { TerrainGenerator } from 'gisaima-shared/map/noise.js';
import { Ops } from '../lib/ops.js';
import { spawn as spawnShipment } from './caravans.js';

const _terrainByWorld = new Map();
async function terrainFor(db, worldId) {
  if (_terrainByWorld.has(worldId)) return _terrainByWorld.get(worldId);
  const w = await db.collection('worlds').findOne({ _id: worldId }, { projection: { 'info.seed': 1 } });
  const gen = new TerrainGenerator(w?.info?.seed ?? 1, 4_000);
  _terrainByWorld.set(worldId, gen);
  return gen;
}

const _DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

function isWater(terrain, x, y) {
  try { return !!terrain.getTerrainData(x, y)?.water; } catch { return false; }
}

// True water-path check: a bounded flood-fill over sea tiles from the open water
// beside the origin port to the open water beside the destination port. Both
// ports sit on land, so we seed/aim at their water-adjacent neighbours. The
// search is boxed (with a margin) and capped so it can never run away on the
// infinite procedural map.
function navigableByWater(terrain, fromX, fromY, toX, toY, { maxExplore = 6000, margin = 60 } = {}) {
  const seed = [];
  for (const [dx, dy] of _DIRS) if (isWater(terrain, fromX + dx, fromY + dy)) seed.push([fromX + dx, fromY + dy]);
  if (!seed.length) return false; // origin isn't actually on the coast

  const goal = new Set();
  for (const [dx, dy] of _DIRS) if (isWater(terrain, toX + dx, toY + dy)) goal.add(`${toX + dx},${toY + dy}`);
  if (!goal.size) return false; // destination isn't on the coast

  const minX = Math.min(fromX, toX) - margin, maxX = Math.max(fromX, toX) + margin;
  const minY = Math.min(fromY, toY) - margin, maxY = Math.max(fromY, toY) + margin;

  const seen = new Set(seed.map(([x, y]) => `${x},${y}`));
  const queue = [...seed];
  let explored = 0;
  while (queue.length && explored < maxExplore) {
    const [x, y] = queue.shift();
    explored++;
    if (goal.has(`${x},${y}`)) return true;
    for (const [dx, dy] of _DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
      const key = `${nx},${ny}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (isWater(terrain, nx, ny)) queue.push([nx, ny]);
    }
  }
  return false;
}

// A structure can launch ships if it has a harbour building.
export function hasHarbour(structure) {
  const b = structure?.buildings || {};
  return Object.keys(b).some(k => {
    const key = k.toLowerCase();
    return key.includes('harbour') || key.includes('dock') || key.includes('port');
  }) || ['harbour', 'port', 'dock'].some(k => b[k]);
}

// Naval only when BOTH ends are ports — a ship needs a harbour to sail from and
// one to dock at. Anything else goes overland by caravan.
export function classifyMode(originStructure, destStructure) {
  return hasHarbour(originStructure) && hasHarbour(destStructure) ? 'naval' : 'land';
}

// Decide the shipping mode for real: naval only when both ends are ports AND an
// actual open-water lane connects them; otherwise an overland caravan. Walks the
// terrain, so it's called once at create/run time and the result is cached on
// the route (terrain never changes) rather than re-checked every autoship tick.
async function resolveMode(db, worldId, originStructure, destStructure, fromX, fromY, toX, toY) {
  if (classifyMode(originStructure, destStructure) !== 'naval') return 'land';
  const terrain = await terrainFor(db, worldId);
  return navigableByWater(terrain, fromX, fromY, toX, toY) ? 'naval' : 'land';
}

// Pull one non-player unit from a structure's garrison to crew a shipment,
// writing the decrement via `ops`. Returns the crew descriptor, or null if the
// garrison has no spare units (the player character is never taken).
function lockCrew(ops, worldId, chunkKey, tileKey, structure) {
  const units = structure?.units;
  if (!units) return null;
  const entries = Array.isArray(units)
    ? units.map((u, i) => [String(i), u])
    : Object.entries(units);

  for (const [key, u] of entries) {
    if (!u || u.type === 'player') continue;
    const qty = Number(u.quantity) || 0;
    if (qty <= 0) continue;
    // Lock one unit off this stack.
    if (qty - 1 > 0) {
      ops.chunk(worldId, chunkKey, `${tileKey}.structure.units.${key}.quantity`, qty - 1);
    } else {
      ops.chunk(worldId, chunkKey, `${tileKey}.structure.units.${key}`, null);
    }
    return {
      id: `crew_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      unitId: u.unitId, type: u.type, race: u.race,
      name: u.name, icon: u.icon, quantity: 1,
      owner: u.owner, category: u.category, level: u.level || 1, xp: 0,
    };
  }
  return null;
}

async function loadTile(db, worldId, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const chunkKey = getChunkKey(x, y);
  const tileKey = `${x},${y}`;
  const chunkDoc = await db.collection('chunks').findOne(
    { worldId, chunkKey },
    { projection: { [`tiles.${tileKey}`]: 1 } }
  );
  return { chunkKey, tileKey, tile: chunkDoc?.tiles?.[tileKey] || null };
}

function sanitizeItems(items) {
  const out = {};
  for (const [code, qty] of Object.entries(items || {})) {
    if (code.startsWith('_')) continue;
    const n = Math.floor(Number(qty));
    if (Number.isFinite(n) && n > 0) out[String(code).toUpperCase()] = n;
  }
  return out;
}

// Deduct `items` from a structure's store, writing the result via `ops`.
// Returns { ok } — false (with reason) if the structure can't cover the manifest.
function chargeStructure(ops, worldId, chunkKey, tileKey, structure, items) {
  const have = structure.items || {};
  for (const [code, qty] of Object.entries(items)) {
    if ((Number(have[code]) || 0) < qty) return { ok: false, reason: `insufficient ${code}` };
  }
  const next = { ...have };
  for (const [code, qty] of Object.entries(items)) {
    next[code] = (Number(next[code]) || 0) - qty;
    if (next[code] <= 0) delete next[code];
  }
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.items`, next);
  return { ok: true };
}

// Validate the endpoints and dispatch one shipment. Shared by createRoute,
// runRoute and the autoship tick. Returns { ok, mode } or { ok:false, reason }.
async function dispatchShipment(db, worldId, ownerUid, { fromX, fromY, toX, toY, items, mode: forcedMode }) {
  const [origin, dest] = await Promise.all([
    loadTile(db, worldId, fromX, fromY),
    loadTile(db, worldId, toX, toY),
  ]);
  if (!origin?.tile?.structure) return { ok: false, reason: 'origin is not a structure' };
  if (!dest?.tile?.structure)   return { ok: false, reason: 'destination is not a structure' };
  if (origin.tile.structure.owner !== ownerUid) return { ok: false, reason: 'you do not own the origin structure' };

  // Naval requires a harbour at BOTH ends AND a navigable sea lane; otherwise a
  // land caravan. Autoship passes the cached mode to skip the terrain walk.
  const mode = forcedMode
    || await resolveMode(db, worldId, origin.tile.structure, dest.tile.structure, fromX, fromY, toX, toY);
  const toUid = dest.tile.structure.owner || null;

  const ops = new Ops();
  const charged = chargeStructure(ops, worldId, origin.chunkKey, origin.tileKey, origin.tile.structure, items);
  if (!charged.ok) return { ok: false, reason: charged.reason };

  // Crew the shipment from the origin garrison — no spare units, no shipment.
  const crew = lockCrew(ops, worldId, origin.chunkKey, origin.tileKey, origin.tile.structure);
  if (!crew) return { ok: false, reason: 'no spare units at the origin to crew the shipment' };

  const shipment = await spawnShipment(db, ops, worldId, {
    fromX, fromY, toX, toY,
    items,
    ownerUid,
    toUid,
    risk: 'safe',
    mode,
    crew,
  });
  if (!shipment) return { ok: false, reason: 'could not dispatch shipment' };

  await ops.flush(db);
  return { ok: true, mode, toUid, toName: dest.tile.structure.ownerName || null };
}

export async function createRoute(db, worldId, ownerUid, ownerName, {
  fromX, fromY, toX, toY, items, autoship = false, template = false,
}) {
  const manifest = sanitizeItems(items);
  if (!Object.keys(manifest).length) throw new Error('nothing to ship');
  if (fromX === toX && fromY === toY) throw new Error('origin and destination are the same');

  const result = await dispatchShipment(db, worldId, ownerUid, { fromX, fromY, toX, toY, items: manifest });
  if (!result.ok) throw new Error(result.reason);

  const now = new Date();
  const doc = {
    worldId,
    ownerUid,
    ownerName: ownerName || 'Unknown',
    fromX, fromY, toX, toY,
    toUid: result.toUid,
    toName: result.toName,
    items: manifest,
    mode: result.mode,
    autoship: !!autoship,
    template: !!template,
    status: 'active',
    createdAt: now,
    lastRunAt: now,
    runCount: 1,
  };
  const r = await db.collection('trade_routes').insertOne(doc);
  return { ...doc, _id: r.insertedId.toString() };
}

export async function listRoutes(db, worldId, ownerUid) {
  const rows = await db.collection('trade_routes')
    .find({ worldId, ownerUid })
    .sort({ lastRunAt: -1 })
    .limit(100)
    .toArray();
  return rows.map(r => ({ ...r, _id: r._id.toString() }));
}

export async function runRoute(db, worldId, ownerUid, routeId) {
  const route = await db.collection('trade_routes').findOne({ _id: new ObjectId(routeId), worldId, ownerUid });
  if (!route) throw new Error('route not found');

  const result = await dispatchShipment(db, worldId, ownerUid, {
    fromX: route.fromX, fromY: route.fromY, toX: route.toX, toY: route.toY, items: route.items,
  });
  if (!result.ok) throw new Error(result.reason);

  await db.collection('trade_routes').updateOne(
    { _id: route._id },
    { $set: { lastRunAt: new Date(), mode: result.mode, toUid: result.toUid }, $inc: { runCount: 1 } }
  );
  return { ok: true, mode: result.mode };
}

export async function setAutoship(db, worldId, ownerUid, routeId, on) {
  await db.collection('trade_routes').updateOne(
    { _id: new ObjectId(routeId), worldId, ownerUid },
    { $set: { autoship: !!on, template: true } }
  );
  return { ok: true };
}

export async function archiveRoute(db, worldId, ownerUid, routeId) {
  await db.collection('trade_routes').updateOne(
    { _id: new ObjectId(routeId), worldId, ownerUid },
    { $set: { status: 'archived', autoship: false } }
  );
  return { ok: true };
}

// Per-tick: dispatch every active autoship route whose origin can cover the
// manifest. Routes that can't (out of goods, structure lost) are skipped, not
// archived, so they resume once the goods return.
export async function tickTradeRoutes(db, worldId) {
  const routes = await db.collection('trade_routes')
    .find({ worldId, status: 'active', autoship: true })
    .limit(500)
    .toArray();
  let shipped = 0;
  for (const route of routes) {
    try {
      const result = await dispatchShipment(db, worldId, route.ownerUid, {
        fromX: route.fromX, fromY: route.fromY, toX: route.toX, toY: route.toY, items: route.items,
        mode: route.mode, // cached — terrain doesn't change, skip the sea-lane walk
      });
      if (result.ok) {
        shipped++;
        await db.collection('trade_routes').updateOne(
          { _id: route._id },
          { $set: { lastRunAt: new Date(), mode: result.mode }, $inc: { runCount: 1 } }
        );
      }
    } catch {
      // Skip this route this tick; it'll retry next tick.
    }
  }
  return shipped;
}
