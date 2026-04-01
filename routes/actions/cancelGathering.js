/**
 * Cancel gathering action
 */

import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { applyUpdates } from '../../db/adapter.js';

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

  const now    = Date.now();
  const chatId = `gather_cancel_${now}_${groupId}`;
  const groupPath = `worlds/${worldId}/chunks/${chunkKey}/${tileKey}/groups/${groupId}`;

  const updates = {
    [`${groupPath}/status`]:                 'idle',
    [`${groupPath}/gatheringBiome`]:         null,
    [`${groupPath}/gatheringTicksRemaining`]: null,
    [`worlds/${worldId}/chat/${chatId}`]: {
      text: `${group.name || 'Unnamed group'} has stopped gathering resources at (${locationX},${locationY})`,
      type: 'event',
      timestamp: now,
      userId: uid,
      userName: group.ownerName || group.name || 'Unknown',
      location: { x: Number(locationX), y: Number(locationY), timestamp: now }
    }
  };

  await applyUpdates(db, updates);

  return { success: true, message: 'Gathering cancelled successfully', timestamp: now };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export { cancelGathering as default };
