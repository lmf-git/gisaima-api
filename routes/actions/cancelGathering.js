/**
 * Cancel gathering action
 */

import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { Ops } from '../../lib/ops.js';

export async function cancelGathering({ uid, data, db }) {
  const { groupId, locationX, locationY, worldId } = data;

  if (!groupId || locationX === undefined || locationY === undefined || !worldId) {
    throw err(400, 'Missing required parameters: groupId, locationX, locationY, worldId');
  }

  const chunkKey = getChunkKey(locationX, locationY);
  const tileKey  = `${locationX},${locationY}`;

  const chunkDoc = await db.collection('chunks').findOne({ worldId, chunkKey });
  const group    = chunkDoc?.tiles?.[tileKey]?.groups?.[groupId];

  if (!group)              throw err(404, 'Group not found at the specified location');
  if (group.owner !== uid) throw err(403, 'You can only cancel gathering of your own groups');

  if (group.status !== 'gathering') {
    return { success: true, message: 'Group is not gathering', status: group.status };
  }

  const now = Date.now();
  const ops = new Ops();
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.status`,                 'idle');
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.gatheringBiome`,         null);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.gatheringTicksRemaining`, null);
  ops.chat(worldId, {
    text: `${group.name || 'Unnamed group'} has stopped gathering resources at (${locationX},${locationY})`,
    type: 'event',
    timestamp: now,
    userId: uid,
    userName: group.ownerName || group.name || 'Unknown',
    location: { x: Number(locationX), y: Number(locationY), timestamp: now }
  });

  await ops.flush(db);

  return { success: true, message: 'Gathering cancelled successfully', timestamp: now };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export { cancelGathering as default };
