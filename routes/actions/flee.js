/**
 * Flee battle action
 */

import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { Ops } from '../../lib/ops.js';

export async function flee({ uid, data, db }) {
  const { groupId, x, y, worldId = 'default' } = data;

  if (!groupId)                        throw err(400, 'Missing groupId parameter');
  if (x === undefined || y === undefined) throw err(400, 'Missing coordinates parameters');

  const chunkKey = getChunkKey(x, y);
  const tileKey  = `${x},${y}`;

  const chunkDoc = await db.collection('chunks').findOne({ worldId, chunkKey });
  const tile     = chunkDoc?.tiles?.[tileKey] || {};
  const group    = tile.groups?.[groupId];

  if (!group)              throw err(404, 'Group not found at specified location');
  if (group.owner !== uid) throw err(403, 'You can only flee battles with your own groups');
  if (!group.battleId)     throw err(409, 'This group is not currently in a battle');

  const battle = tile.battles?.[group.battleId];
  if (!battle) throw err(404, 'Associated battle not found');

  const now         = Date.now();
  const currentTick = battle.tickCount || 0;

  const ops = new Ops();
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.status`,            'fleeing');
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.fleeTickRequested`, currentTick);
  ops.chat(worldId, {
    text: `${group.name || 'A group'} is attempting to flee from battle at (${x}, ${y})!`,
    type: 'event',
    timestamp: now,
    tickCount: currentTick,
    location: { x, y }
  });
  ops.chunk(worldId, chunkKey, `${tileKey}.battles.${group.battleId}.events`, [
    ...(battle.events || []),
    {
      type: 'flee_attempt', tickCount: currentTick,
      text: `${group.name || 'A group'} is attempting to flee from the battle!`,
      groupId, side: group.battleSide
    }
  ]);

  await ops.flush(db);

  return {
    success: true,
    message: 'Flee command issued. Your group will attempt to flee during the next battle tick.',
    tickCount: currentTick
  };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export { flee as default };
