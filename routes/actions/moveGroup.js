/**
 * Move group action
 */

import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { applyUpdates } from '../../db/adapter.js';

function calculatePath(startX, startY, endX, endY) {
  const path = [{ x: startX, y: startY }];
  let x = startX, y = startY;
  const dx = Math.abs(endX - startX);
  const dy = Math.abs(endY - startY);
  const sx = startX < endX ? 1 : -1;
  const sy = startY < endY ? 1 : -1;
  let e = dx - dy;
  while (!(x === endX && y === endY)) {
    const e2 = 2 * e;
    if (e2 > -dy) { e -= dy; x += sx; }
    if (e2 < dx)  { e += dx; y += sy; }
    path.push({ x, y });
    if (path.length > 1000) break;
  }
  return path;
}

export async function moveGroup({ uid, data, db }) {
  const { groupId, fromX, fromY, toX, toY, path, worldId = 'default' } = data;

  if (!groupId)                                                   throw err(400, 'Missing groupId');
  if (fromX === undefined || fromY === undefined || toX === undefined || toY === undefined) {
    throw err(400, 'Missing coordinates parameters');
  }

  const chunkKey = getChunkKey(fromX, fromY);
  const tileKey  = `${fromX},${fromY}`;

  const chunkDoc = await db.collection('chunks').findOne({ worldId, chunkKey });
  const group    = chunkDoc?.tiles?.[tileKey]?.groups?.[groupId];

  if (!group)              throw err(404, 'Group not found at specified location');
  if (group.owner !== uid) throw err(403, 'You can only move your own groups');
  if (group.status !== 'idle') throw err(409, `Group cannot be moved while in ${group.status} status`);

  const worldDoc   = await db.collection('worlds').findOne({ _id: worldId });
  const worldSpeed = worldDoc?.info?.speed || 1.0;
  const now        = Date.now();
  const tickMs     = Math.round(60000 / worldSpeed);
  const movePath   = (path && Array.isArray(path) && path.length > 1)
    ? path : calculatePath(fromX, fromY, toX, toY);
  const chatId = `move_start_${now}_${groupId}`;

  const updates = {
    [`worlds/${worldId}/chunks/${chunkKey}/${tileKey}/groups/${groupId}/status`]:       'moving',
    [`worlds/${worldId}/chunks/${chunkKey}/${tileKey}/groups/${groupId}/movementPath`]: movePath,
    [`worlds/${worldId}/chunks/${chunkKey}/${tileKey}/groups/${groupId}/pathIndex`]:    0,
    [`worlds/${worldId}/chunks/${chunkKey}/${tileKey}/groups/${groupId}/moveStarted`]:  now,
    [`worlds/${worldId}/chunks/${chunkKey}/${tileKey}/groups/${groupId}/moveSpeed`]:    1,
    [`worlds/${worldId}/chunks/${chunkKey}/${tileKey}/groups/${groupId}/nextMoveTime`]: now + tickMs,
    [`worlds/${worldId}/chat/${chatId}`]: {
      type: 'system',
      text: `${group.name || 'Unnamed group'} is setting out from (${fromX},${fromY}) to (${toX},${toY})`,
      timestamp: now,
      location: { x: fromX, y: fromY }
    }
  };

  await applyUpdates(db, updates);

  return {
    success: true,
    message: 'Group movement started',
    path: movePath,
    totalSteps: movePath.length,
    estimatedTimeMs: tickMs * (movePath.length - 1)
  };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export default moveGroup;
