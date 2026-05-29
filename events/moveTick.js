/**
 * Movement tick processing for Gisaima
 * Handles group movement steps during tick cycles
 */

import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { addDistance } from '../db/stats.js';
import { deliver as deliverCaravan } from '../db/caravans.js';
import { patchLife } from '../db/lives.js';

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
    const startPoint = group.movementPath[0];
    const endPoint   = group.movementPath[group.movementPath.length - 1];

    // Caravan delivery — drop items into the recipient's sink, remove the
    // caravan group, and emit a chat event describing the outcome.
    if (group.type === 'caravan' && group.delivery && _db) {
      deliverCaravan(_db, ops, worldId, group, chunkKey, tileKey)
        .then((result) => {
          if (result?.intercepted) {
            ops.chat(worldId, {
              text: `A caravan from ${group.owner?.slice(0, 6) || 'a trader'} was ambushed at (${endPoint.x},${endPoint.y}). Its load is lost to the realm.`,
              type: 'event',
              category: 'player',
              timestamp: now,
              location: { x: endPoint.x, y: endPoint.y }
            });
          } else if (result) {
            ops.chat(worldId, {
              text: `A caravan delivered its load to ${group.delivery.toUid.slice(0, 6)} at (${endPoint.x},${endPoint.y}).`,
              type: 'event',
              category: 'player',
              timestamp: now,
              location: { x: endPoint.x, y: endPoint.y }
            });
          }
        })
        .catch((err) => console.error('[caravan-deliver]', err));
      return true;
    }

    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.status`,       'idle');
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.movementPath`, null);
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.pathIndex`,    null);
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.moveStarted`,  null);
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.moveSpeed`,    null);
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.nextMoveTime`, null);

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
  const moveInterval = Math.round(2 * 60000 / worldSpeed);
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

    // Track distance travelled + last-known location for player-owned groups.
    // Drives wealth/distance rankings, treasure-trail proximity solves,
    // and the per-character chronicle.
    if (_db && group.type !== 'monster' && group.owner) {
      addDistance(_db, worldId, group.owner, 1).catch(() => {});
      _db.collection('players').updateOne(
        { _id: group.owner },
        { $set: { [`worlds.${worldId}.lastLocation`]: { x: nextPoint.x, y: nextPoint.y } } },
        { upsert: true }
      ).catch(() => {});
    }

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
          // unit.id is the character's lifeId; the player doc is keyed by uid.
          const ownerUid = unit.uid || group.owner;
          if (ownerUid) ops.player(ownerUid, worldId, 'lastLocation', { x: nextPoint.x, y: nextPoint.y, timestamp: now });
          if (_db) await patchLife(_db, unit.id, { lastLocation: { x: nextPoint.x, y: nextPoint.y } });
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
