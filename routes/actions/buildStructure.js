/**
 * Build structure action
 */

import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { STRUCTURES } from 'gisaima-shared/definitions/STRUCTURES.js';
import { ITEMS } from 'gisaima-shared/definitions/ITEMS.js';
import { Ops } from '../../lib/ops.js';

export async function buildStructure({ uid, data, db }) {
  const { worldId, groupId, tileX, tileY, structureType, structureName } = data;

  if (!worldId || !groupId || typeof tileX !== 'number' || typeof tileY !== 'number' || !structureType || !structureName) {
    throw err(400, 'Required parameters are missing or invalid.');
  }

  const structureDef = STRUCTURES[structureType];
  if (!structureDef) throw err(400, `Unknown structure type: ${structureType}`);

  const chunkKey = getChunkKey(tileX, tileY);
  const tileKey  = `${tileX},${tileY}`;

  const chunkDoc = await db.collection('chunks').findOne({ worldId, chunkKey });
  const tile     = chunkDoc?.tiles?.[tileKey] || {};
  const group    = tile.groups?.[groupId];

  if (tile.structure)          throw err(409, 'There is already a structure at this location.');
  if (!group)                  throw err(404, 'Group not found at this location.');
  if (group.owner !== uid)     throw err(403, 'You do not own this group.');
  if (group.status !== 'idle') throw err(409, 'Group must be idle to start building.');

  const available = {};
  if (group.items && typeof group.items === 'object' && !Array.isArray(group.items)) {
    for (const [code, qty] of Object.entries(group.items)) available[code] = qty;
  } else if (Array.isArray(group.items)) {
    for (const item of group.items) {
      const id = item.id || item.name;
      available[id] = (available[id] || 0) + (item.quantity || 1);
    }
  }

  const missing = [];
  for (const res of (structureDef.requiredResources || [])) {
    const rid  = res.id || res.name;
    const have = available[rid] || 0;
    if (have < res.quantity) {
      missing.push(`${ITEMS[rid]?.name || rid} (${have}/${res.quantity})`);
    }
  }
  if (missing.length) throw err(409, `Missing resources: ${missing.join(', ')}`);

  const updatedItems = { ...available };
  for (const res of (structureDef.requiredResources || [])) {
    const rid = res.id || res.name;
    updatedItems[rid] = (updatedItems[rid] || 0) - res.quantity;
    if (updatedItems[rid] <= 0) delete updatedItems[rid];
  }

  const now      = Date.now();
  const structId = `structure_${now}_${Math.floor(Math.random() * 10000)}`;

  const playerDoc = await db.collection('players').findOne({ _id: uid });
  const ownerName = playerDoc?.worlds?.[worldId]?.displayName || 'Unknown';

  const ops = new Ops();
  ops.chunk(worldId, chunkKey, `${tileKey}.structure`, {
    id: structId, name: structureName, type: structureType,
    status: 'building', buildProgress: 0,
    owner: uid, ownerName, race: group.race || null, builder: groupId
  });
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.status`, 'building');
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.items`,  updatedItems);
  ops.chat(worldId, {
    type: 'system',
    category: 'player',
    userId: uid,
    text: `${structureName} construction has begun at (${tileX},${tileY})`,
    timestamp: now, location: { x: tileX, y: tileY }
  });

  await ops.flush(db);
  return { success: true, structure: structureType };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export default buildStructure;
