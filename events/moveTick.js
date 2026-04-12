/**
 * Movement tick processing for Gisaima
 * Handles group movement steps during tick cycles
 */

import { getChunkKey } from 'gisaima-shared/map/cartography.js';

export async function processMovement(worldId, ops, group, chunkKey, tileKey, groupId, now, _db, worldInfo = null) {
  if (group.status === 'cancelling') {
    console.log(`Skipping movement for group ${groupId} as it's being cancelled`);
    return false;
  }

  if (group.battleId) {
    console.log(`Skipping movement for group ${groupId} as it's in battle`);
    if (group.status === 'moving') {
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.status`,       'fighting');
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.movementPath`, null);
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.pathIndex`,    null);
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.moveStarted`,  null);
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.moveSpeed`,    null);
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.nextMoveTime`, null);
    }
    return false;
  }

  if (group.status !== 'moving' || !group.nextMoveTime || group.nextMoveTime > now) {
    return false;
  }

  if (!group.movementPath || !Array.isArray(group.movementPath) ||
      group.pathIndex === undefined || group.moveStarted === undefined) {
    console.warn(`Invalid path for group ${groupId} in world ${worldId}`);
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.status`,       'idle');
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.movementPath`, null);
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.pathIndex`,    null);
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.moveStarted`,  null);
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.moveSpeed`,    null);
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.nextMoveTime`, null);
    return false;
  }

  const currentIndex = group.pathIndex || 0;
  const nextIndex    = currentIndex + 1;

  if (nextIndex >= group.movementPath.length) {
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.status`,       'idle');
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.movementPath`, null);
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.pathIndex`,    null);
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.moveStarted`,  null);
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.moveSpeed`,    null);
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.nextMoveTime`, null);

    const startPoint = group.movementPath[0];
    const endPoint   = group.movementPath[group.movementPath.length - 1];
    ops.chat(worldId, {
      text: `${group.name || 'Unnamed force'} completed their journey from (${startPoint.x},${startPoint.y}) to (${endPoint.x},${endPoint.y})`,
      type: 'event',
      category: group.type === 'monster' ? 'monster' : 'player',
      ...(group.type !== 'monster' && group.owner ? { userId: group.owner } : {}),
      timestamp: now,
      location: { x: endPoint.x, y: endPoint.y }
    });
    return true;
  }

  const nextPoint    = group.movementPath[nextIndex];
  const nextChunkKey = getChunkKey(nextPoint.x, nextPoint.y);
  const nextTileKey  = `${nextPoint.x},${nextPoint.y}`;
  const worldSpeed   = worldInfo?.speed || 1.0;
  const moveInterval = Math.round(60000 / worldSpeed);
  const nextMoveTime = now + moveInterval;

  if (nextChunkKey !== chunkKey || nextTileKey !== tileKey) {
    let updatedGroup = { ...group };
    if (nextIndex === group.movementPath.length - 1) {
      const { moveSpeed, moveStarted, nextMoveTime: _nmt, movementPath, pathIndex, ...cleanGroup } = updatedGroup;
      updatedGroup = { ...cleanGroup, status: 'idle', x: nextPoint.x, y: nextPoint.y };
    } else {
      updatedGroup = { ...updatedGroup, x: nextPoint.x, y: nextPoint.y, pathIndex: nextIndex, nextMoveTime, status: 'moving' };
    }

    // Preserve monster-specific properties
    if (group.type === 'monster') {
      updatedGroup.type = 'monster';
      for (const prop of ['personality', 'motion', 'explorationPhase', 'explorationTicks',
                          'mobilizedFromStructure', 'preferredStructureId', 'targetStructure', 'attackIntent']) {
        if (group[prop] !== undefined) updatedGroup[prop] = group[prop];
      }
    }

    // Update passenger coordinates when the boat moves
    if (updatedGroup.passengers) {
      for (const [pid, pg] of Object.entries(updatedGroup.passengers)) {
        updatedGroup.passengers[pid] = { ...pg, x: nextPoint.x, y: nextPoint.y };
      }
    }

    ops.chunk(worldId, nextChunkKey, `${nextTileKey}.groups.${groupId}`, updatedGroup);
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}`, null);

    const isSignificant = nextIndex % 3 === 0 || nextIndex === group.movementPath.length - 1;
    if (isSignificant) {
      ops.chat(worldId, {
        text: `${group.name || 'Unnamed force'} has arrived at (${nextPoint.x},${nextPoint.y})${nextIndex < group.movementPath.length - 1 ? ' and continues their journey' : ''}`,
        type: 'event',
        category: group.type === 'monster' ? 'monster' : 'player',
        ...(group.type !== 'monster' && group.owner ? { userId: group.owner } : {}),
        timestamp: now,
        location: { x: nextPoint.x, y: nextPoint.y }
      });
    }

    if (group.units) {
      const units = Array.isArray(group.units) ? group.units : Object.values(group.units);
      for (const unit of units) {
        if (unit.type === 'player' && unit.id) {
          ops.player(unit.id, worldId, 'lastLocation', { x: nextPoint.x, y: nextPoint.y, timestamp: now });
        }
      }
    }
  } else {
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.pathIndex`,    nextIndex);
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.nextMoveTime`, nextMoveTime);
    if (nextIndex === group.movementPath.length - 1) {
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.status`,       'idle');
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.moveStarted`,  null);
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.moveSpeed`,    null);
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.movementPath`, null);
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.pathIndex`,    null);
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.nextMoveTime`, null);
    }
  }

  return true;
}
