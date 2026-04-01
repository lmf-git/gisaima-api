/**
 * Start gathering action
 */

import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { applyUpdates } from '../../db/adapter.js';

export async function startGathering({ uid, data, db }) {
  const { groupId, locationX, locationY, worldId } = data;

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

  const biome  = tile.biome?.name || 'plains';
  const now    = Date.now();
  const chatId = `gather_start_${now}_${groupId}`;

  const updates = {
    [`worlds/${worldId}/chunks/${chunkKey}/${tileKey}/groups/${groupId}/status`]:                 'gathering',
    [`worlds/${worldId}/chunks/${chunkKey}/${tileKey}/groups/${groupId}/gatheringBiome`]:         biome,
    [`worlds/${worldId}/chunks/${chunkKey}/${tileKey}/groups/${groupId}/gatheringTicksRemaining`]: 2,
    [`worlds/${worldId}/chat/${chatId}`]: {
      type: 'system',
      text: `${group.name} has started gathering in ${biome} biome at (${locationX},${locationY})`,
      timestamp: now,
      location: { x: locationX, y: locationY }
    }
  };

  await applyUpdates(db, updates);

  // Achievement (best-effort)
  const playerDoc = await db.collection('players').findOne({ _id: uid });
  if (!playerDoc?.worlds?.[worldId]?.achievements?.first_gather) {
    await db.collection('players').updateOne(
      { _id: uid },
      { $set: { [`worlds.${worldId}.achievements.first_gather`]: true } },
      { upsert: true }
    );
  }

  return { success: true, message: 'Gathering started', completesIn: 2 };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export default startGathering;
