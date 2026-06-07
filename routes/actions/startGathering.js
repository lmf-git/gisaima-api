/**
 * Start gathering action
 */

import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { merge, groupCarryCapacity, itemCount } from 'gisaima-shared/economy/items.js';
import { Ops } from '../../lib/ops.js';
import { grantAchievement } from '../../lib/achievements.js';

export async function startGathering({ uid, data, db }) {
  const { groupId, locationX, locationY, worldId, gatherUntilFull = false } = data;
  // Item codes the player chose to scoop up off the tile before biome gathering.
  const collectItems = Array.isArray(data.collectItems) ? data.collectItems : [];

  if (!groupId || locationX === undefined || locationY === undefined || !worldId) {
    throw err(400, 'Missing required parameters');
  }

  const chunkKey = getChunkKey(locationX, locationY);
  const tileKey  = `${locationX},${locationY}`;

  const chunkDoc = await db.collection('chunks').findOne({ worldId, chunkKey });
  const tile     = chunkDoc?.tiles?.[tileKey] || {};
  const group    = tile.groups?.[groupId];

  if (!group)              throw err(404, 'Group not found on this tile');
  if (group.owner !== uid) throw err(403, 'You do not own this group');
  if (group.status !== 'idle') throw err(409, 'Group is not idle and cannot gather');

  const biome = tile.biome?.name || 'plains';
  const now   = Date.now();
  const GATHER_TICKS = 2;

  const ops = new Ops();

  // Pick up the selected tile items into the group first, limited by what the
  // group can still carry. Whatever fits is moved off the tile; biome gathering
  // then fills any remaining capacity during the tick.
  if (collectItems.length && tile.items && typeof tile.items === 'object') {
    const capacity = groupCarryCapacity(group);
    let room = capacity > 0 ? Math.max(0, capacity - itemCount(group.items)) : Infinity;

    const tileItems = { ...tile.items };
    const picked = {};
    for (const raw of collectItems) {
      if (room <= 0) break;
      const code = String(raw).toUpperCase();
      if (code.startsWith('_')) continue;
      const avail = Number(tileItems[code]) || 0;
      if (avail <= 0) continue;
      const take = Math.min(avail, room);
      picked[code] = take;
      tileItems[code] = avail - take;
      if (tileItems[code] <= 0) delete tileItems[code];
      room -= take;
    }

    if (Object.keys(picked).length) {
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.items`, merge(group.items || {}, picked));
      ops.chunk(worldId, chunkKey, `${tileKey}.items`, tileItems);
    }
  }

  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.status`,                 'gathering');
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.gatheringBiome`,         biome);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.gatheringTicksRemaining`, GATHER_TICKS);
  if (gatherUntilFull) {
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.gatherUntilFull`,      true);
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.gatherTickDuration`,   GATHER_TICKS);
  }
  ops.chat(worldId, {
    type: 'system',
    category: 'player',
    userId: uid,
    text: `${group.name} has started gathering${gatherUntilFull ? ' until full' : ''} in ${biome} biome at (${locationX},${locationY})`,
    timestamp: now,
    location: { x: locationX, y: locationY }
  });

  await ops.flush(db);

  await grantAchievement(db, uid, worldId, 'first_gather');

  return { success: true, message: 'Gathering started', completesIn: GATHER_TICKS };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export default startGathering;
