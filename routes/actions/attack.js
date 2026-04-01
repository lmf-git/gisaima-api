/**
 * Attack action — creates a battle between groups / structures
 */

import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { applyUpdates } from '../../db/adapter.js';

export async function attack({ uid, data, db }) {
  const { worldId, attackerGroupIds, defenderGroupIds, structureId, locationX, locationY } = data;

  if (!attackerGroupIds?.length)                   throw err(400, 'Must provide at least one attacker group');
  if (locationX === undefined || locationY === undefined) throw err(400, 'Must provide location coordinates');
  if (!defenderGroupIds?.length && !structureId)   throw err(400, 'Must provide at least one target');

  const chunkKey   = getChunkKey(locationX, locationY);
  const locationKey = `${locationX},${locationY}`;

  const chunkDoc = await db.collection('chunks').findOne({ worldId, chunkKey });
  const tile     = chunkDoc?.tiles?.[locationKey] || {};
  const groups   = tile.groups || {};

  // Validate attacker groups
  const attackerGroups = [];
  for (const gid of attackerGroupIds) {
    const g = groups[gid];
    if (!g)              throw err(404, `Attacker group ${gid} not found`);
    if (g.owner !== uid) throw err(403, `You do not own group ${gid}`);
    if (g.status !== 'idle') throw err(409, `Group ${gid} is not idle (status: ${g.status})`);
    attackerGroups.push({ ...g, id: gid });
  }

  // Validate defender groups
  const defenderGroups = [];
  for (const gid of (defenderGroupIds || [])) {
    const g = groups[gid];
    if (!g)              throw err(404, `Defender group ${gid} not found`);
    if (g.owner === uid) throw err(403, 'You cannot attack your own groups');
    if (!['idle','gathering','moving','building'].includes(g.status)) {
      throw err(409, `Group ${gid} cannot be attacked (status: ${g.status})`);
    }
    defenderGroups.push({ ...g, id: gid });
  }

  // Validate structure target
  let structure = null;
  if (structureId) {
    if (!tile.structure || tile.structure.id !== structureId) throw err(404, 'Structure not found');
    if (tile.structure.owner === uid) throw err(403, 'You cannot attack your own structure');
    if (tile.structure.battleId)      throw err(409, 'Structure is already in battle');
    structure = { ...tile.structure, id: structureId };
  }

  const now      = Date.now();
  const battleId = `battle_${now}_${Math.floor(Math.random() * 1000)}`;

  const battleData = {
    id: battleId, locationX, locationY,
    targetTypes: [...(defenderGroups.length ? ['group'] : []), ...(structure ? ['structure'] : [])],
    side1: {
      groups: Object.fromEntries(attackerGroupIds.map(id => {
        const g = attackerGroups.find(x => x.id === id);
        return [id, { type: g.type || 'player', race: g.race || 'unknown', units: g.units || {} }];
      })),
      name: getSideName(attackerGroups, null, 1)
    },
    side2: {
      groups: Object.fromEntries((defenderGroupIds || []).map(id => {
        const g = defenderGroups.find(x => x.id === id);
        return [id, { type: g.type || 'player', race: g.race || 'unknown', units: g.units || {} }];
      })),
      name: getSideName(defenderGroups, structure, 2)
    },
    tickCount: 0
  };
  if (structure) battleData.structureId = structure.id;

  const updates = {
    [`worlds/${worldId}/chunks/${chunkKey}/${locationKey}/battles/${battleId}`]: battleData,
    [`worlds/${worldId}/chat/battle_start_${now}_${battleId}`]: {
      text: `Battle has begun at (${locationX}, ${locationY})! ${battleData.side1.name} is attacking ${battleData.side2.name}!`,
      type: 'event', timestamp: now, location: { x: locationX, y: locationY }
    }
  };

  for (const g of attackerGroups) {
    const base = `worlds/${worldId}/chunks/${chunkKey}/${locationKey}/groups/${g.id}`;
    updates[`${base}/battleId`]   = battleId;
    updates[`${base}/battleSide`] = 1;
    updates[`${base}/battleRole`] = 'attacker';
    updates[`${base}/status`]     = 'fighting';
  }

  for (const g of defenderGroups) {
    const base = `worlds/${worldId}/chunks/${chunkKey}/${locationKey}/groups/${g.id}`;
    updates[`${base}/battleId`]   = battleId;
    updates[`${base}/battleSide`] = 2;
    updates[`${base}/battleRole`] = 'defender';
    updates[`${base}/status`]     = 'fighting';
    if (g.status === 'moving') {
      updates[`${base}/movementPath`] = null; updates[`${base}/pathIndex`] = null;
      updates[`${base}/moveStarted`]  = null; updates[`${base}/moveSpeed`]  = null;
      updates[`${base}/nextMoveTime`] = null;
    }
    if (g.status === 'gathering') {
      updates[`${base}/gatheringBiome`] = null;
      updates[`${base}/gatheringTicksRemaining`] = null;
    }
  }

  if (structure) {
    updates[`worlds/${worldId}/chunks/${chunkKey}/${locationKey}/structure/battleId`] = battleId;
  }

  if (attackerGroups.length) {
    const ownerId = attackerGroups[0].owner;
    updates[`players/${ownerId}/worlds/${worldId}/achievements/first_attack`]      = true;
    updates[`players/${ownerId}/worlds/${worldId}/achievements/first_attack_date`] = now;
  }

  await applyUpdates(db, updates);
  return { success: true, message: 'Attack started successfully', battleId };
}

function getSideName(groups, structure, sideNumber) {
  if (!groups.length && !structure) return `Side ${sideNumber}`;
  if (groups.length === 1) return groups[0].name || `Group ${groups[0].id.slice(-4)}`;
  if (groups.length > 1) {
    const races = {};
    groups.forEach(g => { const r = g.race || 'unknown'; races[r] = (races[r] || 0) + 1; });
    let top = 'unknown', max = 0;
    for (const [r, c] of Object.entries(races)) if (c > max) { top = r; max = c; }
    return `${top.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')} Coalition`;
  }
  if (structure) return `${structure.name || 'Structure'} Defenders`;
  return `Side ${sideNumber}`;
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export { attack as default };
