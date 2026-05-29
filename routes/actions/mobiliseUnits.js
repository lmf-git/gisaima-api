/**
 * Mobilise action — creates a new group from units at a tile
 */

import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { TerrainGenerator } from 'gisaima-shared/map/noise.js';
import UNITS from 'gisaima-shared/definitions/UNITS.js';
import { Ops } from '../../lib/ops.js';
import { isInsideExclusion } from '../../db/spawns.js';
import { getPlayerWorldData } from '../../db/players.js';
import { patchLife } from '../../db/lives.js';
import { invalidate as invalidateVisibility } from '../../lib/visibility.js';

// Cache one terrain generator per world for the lifetime of the process.
const _terrainByWorld = new Map();
async function _terrainFor(db, worldId) {
  if (_terrainByWorld.has(worldId)) return _terrainByWorld.get(worldId);
  const w = await db.collection('worlds').findOne({ _id: worldId }, { projection: { 'info.seed': 1 } });
  const gen = new TerrainGenerator(w?.info?.seed ?? 1, 4_000);
  _terrainByWorld.set(worldId, gen);
  return gen;
}

export async function mobiliseUnits({ uid, data, db }) {
  const {
    worldId, tileX, tileY, units = [], includePlayer, name, race,
    fleeAtLosses, joinBattlesInProgress
  } = data;

  if (!worldId || typeof tileX !== 'number' || typeof tileY !== 'number') {
    throw err(400, 'Required parameters are missing or invalid.');
  }
  if (!name || typeof name !== 'string' || !name.trim()) throw err(400, 'Group name is required.');

  const chunkKey = getChunkKey(tileX, tileY);
  const tileKey  = `${tileX},${tileY}`;

  const chunkDoc = await db.collection('chunks').findOne({ worldId, chunkKey });
  const tile     = chunkDoc?.tiles?.[tileKey] || {};

  // Which character is being mobilised — the controlled one unless the client
  // names a specific lifeId. Entities are keyed by lifeId.
  const playerData = await getPlayerWorldData(db, uid, worldId);
  const lifeId = String(data.lifeId || playerData?.controlledLifeId || '');
  if (!lifeId) throw err(409, 'No active character to mobilise');

  if (!tile.players?.[lifeId] && !_playerInGroups(tile.groups, lifeId)) {
    throw err(409, 'Character not found on this tile');
  }

  if (_playerInActiveGroup(tile.groups, lifeId)) {
    throw err(409, 'Character is already mobilising or moving');
  }

  // Block mobilisation on water unless the new group's payload includes a boat —
  // the actual boat check happens below where motion caps are accumulated. We
  // do a cheap pre-check here for the common case (mobilising plain ground
  // units from a flooded / shore tile after a wash).
  try {
    const terrain = await _terrainFor(db, worldId);
    const tileData = terrain.getTerrainData(tileX, tileY);
    if (tileData?.water) {
      // Only allow mobilising on water if the units include something with a
      // boat capacity. We can't know that until we walk the unit list, so set a
      // flag and re-check after the motion accumulator.
      data._tileIsWater = true;
    }

    // Block mobilising inside another player's spawn exclusion zone.
    const zone = await isInsideExclusion(db, worldId, tileX, tileY, uid);
    if (zone) {
      throw err(403, `Cannot mobilise inside the exclusion zone of ${zone.name || zone.kind} spawn`);
    }
  } catch (e) {
    if (e.status) throw e;
  }

  if (units.length > 0) {
    const ownedUnits = new Set();
    for (const g of Object.values(tile.groups || {})) {
      if (g.owner === uid) {
        for (const u of Object.values(g.units || {})) {
          if (u.type !== 'player') ownedUnits.add(u.id);
        }
      }
    }
    const invalid = units.filter(id => !ownedUnits.has(id));
    if (invalid.length) throw err(403, `You don't own some requested units: ${invalid.join(', ')}`);
  }

  const now        = Date.now();
  const newGroupId = `group_${now}_${Math.floor(Math.random() * 10000)}`;
  const newGroup   = {
    id: newGroupId,
    name: name.trim(),
    owner: uid,
    status: 'mobilizing',
    mobilizedAt: now,
    x: tileX,
    y: tileY,
    race: race || null,
    units: {},
    // Rule of march — captured at mobilise time, consumed by battleTick when
    // determining whether to flee and by joinBattle resolution. Validated to
    // safe defaults so a malformed client payload can't lock a group.
    fleeAtLosses: Math.max(0, Math.min(100, Number(fleeAtLosses) || 40)),
    joinBattlesInProgress: joinBattlesInProgress !== false
  };
  const motionCaps = new Set();
  let hasBoat = false, boatCapacity = 0, nonBoatCount = 0;

  const updatedGroups = JSON.parse(JSON.stringify(tile.groups || {}));

  if (units.length > 0) {
    for (const [gid, g] of Object.entries(updatedGroups)) {
      if (g.owner !== uid || !g.units) continue;
      for (const [unitKey, unit] of Object.entries(g.units)) {
        if (!units.includes(unit.id) || unit.type === 'player') continue;
        newGroup.units[unitKey] = unit;
        delete g.units[unitKey];
        const def = UNITS[unit.type] || {};
        (def.motion || ['ground']).forEach(m => motionCaps.add(m));
        if (def.motion?.includes('water') && def.capacity) {
          hasBoat = true; boatCapacity += def.capacity;
        } else nonBoatCount++;
      }
      if (!Object.keys(g.units).length) delete updatedGroups[gid];
    }
  }

  if (includePlayer && tile.players?.[lifeId]) {
    const player = tile.players[lifeId];
    newGroup.units[lifeId] = { ...player, id: lifeId, uid, type: 'player' };
    motionCaps.add('ground');
  }

  if (hasBoat) {
    newGroup.motion = ['water'];
    newGroup.boatCapacity = boatCapacity;
    newGroup.transportedUnits = nonBoatCount;
  } else {
    const m = Array.from(motionCaps);
    newGroup.motion = m.length ? (m.includes('water') && !m.includes('ground') && !m.includes('flying') ? ['water'] : m) : ['ground'];
  }

  // Final water gate — if the mobilisation tile is water, the group must have
  // a boat (or be water-motion). Without that, a player would form a banner
  // standing in the sea.
  if (data._tileIsWater && !hasBoat && !newGroup.motion.includes('water')) {
    throw err(409, 'Cannot mobilise ground units on water — bring a boat with capacity for everyone.');
  }

  updatedGroups[newGroupId] = newGroup;

  const ops = new Ops();
  ops.chunk(worldId, chunkKey, `${tileKey}.groups`, updatedGroups);
  ops.chat(worldId, {
    type: 'system',
    category: 'player',
    userId: uid,
    text: `${name.trim()} is being mobilized at (${tileX},${tileY})`,
    timestamp: now, location: { x: tileX, y: tileY }
  });
  ops.player(uid, worldId, 'achievements.mobilised', true);

  if (includePlayer) {
    ops.chunk(worldId, chunkKey, `${tileKey}.players.${lifeId}`, null);
    ops.player(uid, worldId, 'lastLocation', { x: tileX, y: tileY });
    ops.player(uid, worldId, 'inGroup',      newGroupId);
  }

  await ops.flush(db);

  // Per-character placement: this life is now travelling inside the group.
  if (includePlayer) {
    await patchLife(db, lifeId, { inGroup: newGroupId, lastLocation: { x: tileX, y: tileY } });
  }

  // Sight sources changed (player entity → group) — rebuild on next fetch.
  invalidateVisibility(worldId);

  return { success: true, groupId: newGroupId };
}

function _playerInGroups(groups, lifeId) {
  if (!groups) return false;
  for (const g of Object.values(groups)) {
    if (!g.units) continue;
    if (Object.values(g.units).some(u => u.type === 'player' && String(u.id) === String(lifeId))) return true;
  }
  return false;
}

function _playerInActiveGroup(groups, lifeId) {
  if (!groups) return false;
  for (const g of Object.values(groups)) {
    if (g.status !== 'mobilizing' && g.status !== 'moving') continue;
    if (!g.units) continue;
    if (Object.values(g.units).some(u => u.type === 'player' && String(u.id) === String(lifeId))) return true;
  }
  return false;
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export default mobiliseUnits;
