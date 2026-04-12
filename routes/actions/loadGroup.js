/**
 * Load a unit group onto a boat group as passengers
 */

import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { Ops } from '../../lib/ops.js';

export async function loadGroup({ uid, data, db }) {
  const { worldId, boatGroupId, passengerGroupId, tileX, tileY } = data;

  if (!worldId || !boatGroupId || !passengerGroupId || tileX === undefined || tileY === undefined) {
    throw err(400, 'Missing required parameters');
  }

  const chunkKey = getChunkKey(tileX, tileY);
  const tileKey  = `${tileX},${tileY}`;

  const chunkDoc = await db.collection('chunks').findOne({ worldId, chunkKey });
  const tile     = chunkDoc?.tiles?.[tileKey];
  if (!tile?.groups) throw err(404, 'No groups found at this tile');

  const boatGroup      = tile.groups[boatGroupId];
  const passengerGroup = tile.groups[passengerGroupId];

  if (!boatGroup)      throw err(404, 'Boat group not found at this tile');
  if (!passengerGroup) throw err(404, 'Passenger group not found at this tile');

  if (boatGroup.owner !== uid)      throw err(403, 'You do not own the boat group');
  if (passengerGroup.owner !== uid) throw err(403, 'You do not own the passenger group');

  if (!boatGroup.motion?.includes('water')) {
    throw err(400, 'Target group is not a water-capable (boat) group');
  }
  if (!boatGroup.boatCapacity) {
    throw err(400, 'Target group has no boat capacity');
  }
  if (boatGroup.status !== 'idle') {
    throw err(409, `Boat group cannot load passengers while in ${boatGroup.status} status`);
  }
  if (passengerGroup.status !== 'idle') {
    throw err(409, `Passenger group cannot be loaded while in ${passengerGroup.status} status`);
  }

  // Count existing passengers
  const existingPassengerUnits = Object.values(boatGroup.passengers || {})
    .reduce((sum, g) => sum + Object.keys(g.units || {}).length, 0);
  const newUnits = Object.keys(passengerGroup.units || {}).length;
  const usedCapacity = (boatGroup.transportedUnits || 0) + existingPassengerUnits;

  if (usedCapacity + newUnits > boatGroup.boatCapacity) {
    throw err(400, `Not enough capacity. Boat has ${boatGroup.boatCapacity - usedCapacity} free slot(s), group has ${newUnits} unit(s)`);
  }

  const updatedGroups = JSON.parse(JSON.stringify(tile.groups));

  // Embed passenger group into boat's passengers map
  updatedGroups[boatGroupId].passengers = {
    ...(updatedGroups[boatGroupId].passengers || {}),
    [passengerGroupId]: { ...passengerGroup, status: 'embarked' }
  };

  // Remove passenger group from tile
  delete updatedGroups[passengerGroupId];

  const ops = new Ops();
  ops.chunk(worldId, chunkKey, `${tileKey}.groups`, updatedGroups);
  ops.chat(worldId, {
    type: 'system',
    category: 'player',
    userId: uid,
    text: `${passengerGroup.name || 'A group'} has boarded ${boatGroup.name || 'a boat'} at (${tileX},${tileY})`,
    timestamp: Date.now(),
    location: { x: tileX, y: tileY }
  });

  await ops.flush(db);
  return { success: true };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export default loadGroup;
