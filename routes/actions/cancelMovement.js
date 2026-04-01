/**
 * Cancel movement action
 */

import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { applyUpdates } from '../../db/adapter.js';

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

  const now       = Date.now();
  const chatId    = `move_cancel_${now}_${groupId}`;
  const groupPath = `worlds/${worldId}/chunks/${chunkKey}/${tileKey}/groups/${groupId}`;

  const updates = {
    [`${groupPath}/status`]:       'idle',
    [`${groupPath}/movementPath`]: null,
    [`${groupPath}/pathIndex`]:    null,
    [`${groupPath}/moveStarted`]:  null,
    [`${groupPath}/moveSpeed`]:    null,
    [`${groupPath}/nextMoveTime`]: null,
    [`worlds/${worldId}/chat/${chatId}`]: {
      text: `${group.name || 'Unnamed group'} has stopped their journey at (${x},${y})`,
      type: 'event',
      timestamp: now,
      userId: uid,
      userName: group.name || 'Unknown',
      location: { x: Number(x), y: Number(y), timestamp: now }
    }
  };

  await applyUpdates(db, updates);

  return { success: true, message: 'Movement cancelled successfully', timestamp: now };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export { cancelMovement as default };
