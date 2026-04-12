/**
 * Cancel movement action
 */

import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { Ops } from '../../lib/ops.js';

export async function cancelMovement({ uid, data, db }) {
  const { worldId, groupId, x, y } = data;

  if (!worldId || !groupId || x === undefined || y === undefined) {
    throw err(400, 'Missing required parameters: worldId, groupId, x, y');
  }

  const chunkKey = getChunkKey(x, y);
  const tileKey  = `${x},${y}`;

  const chunkDoc = await db.collection('chunks').findOne({ worldId, chunkKey });
  const group    = chunkDoc?.tiles?.[tileKey]?.groups?.[groupId];

  if (!group)              throw err(404, 'Group not found at the specified location');
  if (group.owner !== uid) throw err(403, 'You can only cancel movement of your own groups');

  if (group.status !== 'moving') {
    return { success: true, message: 'Group is not moving', status: group.status };
  }

  const now = Date.now();
  const ops = new Ops();
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.status`,       'idle');
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.movementPath`, null);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.pathIndex`,    null);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.moveStarted`,  null);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.moveSpeed`,    null);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.nextMoveTime`, null);
  ops.chat(worldId, {
    text: `${group.name || 'Unnamed group'} has stopped their journey at (${x},${y})`,
    type: 'event',
    category: 'player',
    timestamp: now,
    userId: uid,
    userName: group.name || 'Unknown',
    location: { x: Number(x), y: Number(y), timestamp: now }
  });

  await ops.flush(db);

  return { success: true, message: 'Movement cancelled successfully', timestamp: now };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export { cancelMovement as default };
