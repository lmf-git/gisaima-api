/**
 * Demobilise action — flags a group to be disbanded on next tick
 */

import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { Ops } from '../../lib/ops.js';

export async function demobiliseUnits({ uid, data, db }) {
  const { groupId, locationX, locationY, worldId = 'default', storageDestination = 'shared' } = data;

  if (!groupId || locationX === undefined || locationY === undefined) {
    throw err(400, 'Missing required parameters');
  }

  const storage  = ['shared', 'personal'].includes(storageDestination) ? storageDestination : 'shared';
  const chunkKey = getChunkKey(locationX, locationY);
  const tileKey  = `${locationX},${locationY}`;

  const chunkDoc  = await db.collection('chunks').findOne({ worldId, chunkKey });
  const tile      = chunkDoc?.tiles?.[tileKey] || {};
  const group     = tile.groups?.[groupId];
  const structure = tile.structure;

  if (!group)                          throw err(404, 'Group not found');
  if (group.owner !== uid)             throw err(403, 'You do not own this group');
  if (group.status === 'demobilising') throw err(409, 'Group is already demobilising');
  if (!structure)                      throw err(409, 'No structure found at this location');
  if (!structure.id)                   throw err(409, 'Structure has no ID');

  const hasPlayerUnit = Object.values(group.units || {}).some(u => u.type === 'player');
  const now   = Date.now();
  const [chunkXStr, chunkYStr] = chunkKey.split(',');

  const ops = new Ops();
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.status`,             'demobilising');
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.targetStructureId`,  structure.id);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.storageDestination`, storage);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.demobilizationData`, {
    hasPlayer: hasPlayerUnit,
    exactLocation: {
      x: locationX, y: locationY,
      chunkX: Number(chunkXStr), chunkY: Number(chunkYStr),
      tileKey, chunkKey
    }
  });
  ops.chat(worldId, {
    type: 'system',
    text: `${group.name || 'Group'} is demobilizing at (${locationX},${locationY})`,
    timestamp: now,
    location: { x: locationX, y: locationY }
  });

  if (hasPlayerUnit) {
    ops.player(uid, worldId, 'lastLocation', { x: locationX, y: locationY });
  }

  await ops.flush(db);

  return {
    status: 'demobilising',
    message: 'Group is demobilising and will complete on next world update',
    hasPlayer: hasPlayerUnit,
    storageDestination: storage
  };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export default demobiliseUnits;
