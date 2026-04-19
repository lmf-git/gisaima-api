/**
 * Mobilise action — creates a new group from units at a tile
 */

import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import UNITS from 'gisaima-shared/definitions/UNITS.js';
import { Ops } from '../../lib/ops.js';

export async function mobiliseUnits({ uid, data, db }) {
  const { worldId, tileX, tileY, units = [], includePlayer, name, race } = data;

  if (!worldId || typeof tileX !== 'number' || typeof tileY !== 'number') {
    throw err(400, 'Required parameters are missing or invalid.');
  }
  if (!name || typeof name !== 'string' || !name.trim()) throw err(400, 'Group name is required.');

  const chunkKey = getChunkKey(tileX, tileY);
  const tileKey  = `${tileX},${tileY}`;

  const chunkDoc = await db.collection('chunks').findOne({ worldId, chunkKey });
  const tile     = chunkDoc?.tiles?.[tileKey] || {};

  if (!tile.players?.[uid] && !_playerInGroups(tile.groups, uid)) {
    throw err(409, 'Player not found on this tile');
  }

  if (_playerInActiveGroup(tile.groups, uid)) {
    throw err(409, 'Player is already mobilising or moving');
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
  const newGroup   = { id: newGroupId, name: name.trim(), owner: uid, status: 'mobilizing', mobilizedAt: now, x: tileX, y: tileY, race: race || null, units: {} };
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

  if (includePlayer && tile.players?.[uid]) {
    const player = tile.players[uid];
    newGroup.units[uid] = { ...player, type: 'player' };
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
    ops.chunk(worldId, chunkKey, `${tileKey}.players.${uid}`, null);
    ops.player(uid, worldId, 'lastLocation', { x: tileX, y: tileY });
    ops.player(uid, worldId, 'inGroup',      newGroupId);
  }

  await ops.flush(db);
  return { success: true, groupId: newGroupId };
}

function _playerInGroups(groups, uid) {
  if (!groups) return false;
  for (const g of Object.values(groups)) {
    if (!g.units) continue;
    if (Object.values(g.units).some(u => u.type === 'player' && u.id === uid)) return true;
  }
  return false;
}

function _playerInActiveGroup(groups, uid) {
  if (!groups) return false;
  for (const g of Object.values(groups)) {
    if (g.status !== 'mobilizing' && g.status !== 'moving') continue;
    if (!g.units) continue;
    if (Object.values(g.units).some(u => u.type === 'player' && u.id === uid)) return true;
  }
  return false;
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export default mobiliseUnits;
