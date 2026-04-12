/**
 * Join battle action — adds a group to an existing battle
 */

import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { Ops } from '../../lib/ops.js';

export async function joinBattle({ uid, data, db }) {
  const { groupId, battleId, side, locationX, locationY, worldId = 'default' } = data;

  if (!groupId || !battleId || !side || locationX === undefined || locationY === undefined) {
    throw err(400, 'Missing required parameters');
  }
  if (side !== 1 && side !== 2) throw err(400, 'Side must be 1 or 2');

  const chunkKey    = getChunkKey(locationX, locationY);
  const locationKey = `${locationX},${locationY}`;

  const chunkDoc = await db.collection('chunks').findOne({ worldId, chunkKey });
  const tile     = chunkDoc?.tiles?.[locationKey] || {};
  const battle   = tile.battles?.[battleId];
  const group    = tile.groups?.[groupId];

  if (!battle)              throw err(404, 'Battle not found at this location');
  if (!group)               throw err(404, 'Group not found at this location');
  if (group.owner !== uid)  throw err(403, 'You can only join battles with your own groups');
  if (group.status === 'fighting') throw err(409, 'This group is already in battle');

  const now      = Date.now();
  const sideName = (side === 1 ? battle.side1?.name : battle.side2?.name) || `Side ${side}`;
  const groupName = group.name || `Group ${groupId.slice(-4)}`;
  const sideKey  = `side${side}`;

  const ops = new Ops();
  ops.chunk(worldId, chunkKey, `${locationKey}.battles.${battleId}.${sideKey}.groups.${groupId}`, {
    type: group.type || 'player',
    race: group.race || 'unknown'
  });
  ops.chunk(worldId, chunkKey, `${locationKey}.battles.${battleId}.events`, [
    ...(battle.events || []),
    { type: 'join', timestamp: now, text: `${groupName} has joined the battle on ${sideName}'s side!`, groupId }
  ]);
  ops.chunk(worldId, chunkKey, `${locationKey}.groups.${groupId}.battleId`,   battleId);
  ops.chunk(worldId, chunkKey, `${locationKey}.groups.${groupId}.battleSide`, side);
  ops.chunk(worldId, chunkKey, `${locationKey}.groups.${groupId}.battleRole`, 'supporter');
  ops.chunk(worldId, chunkKey, `${locationKey}.groups.${groupId}.status`,     'fighting');
  ops.player(uid, worldId, 'achievements.battle_joiner',      true);
  ops.player(uid, worldId, 'achievements.battle_joiner_date', now);
  ops.chat(worldId, {
    text: `${groupName} has joined the battle at (${locationX}, ${locationY}) on ${sideName}'s side!`,
    type: 'event', category: 'player', userId: uid, timestamp: now, location: { x: locationX, y: locationY }
  });

  await ops.flush(db);
  return { success: true, message: `Joined battle on ${sideName}'s side`, battleId };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export { joinBattle as default };
