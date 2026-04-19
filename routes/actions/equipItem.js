import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { ITEMS } from 'gisaima-shared/definitions/ITEMS.js';
import { EQUIPMENT_SLOTS } from 'gisaima-shared/definitions/EQUIPMENT_SLOTS.js';
import { Ops } from '../../lib/ops.js';

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

/**
 * Equip or unequip an item in a unit's equipment slot.
 *
 * data: {
 *   worldId, tileX, tileY, groupId, unitId, slot,
 *   itemCode,      // item to equip; null/omitted to unequip
 *   source,        // 'group' | 'structure' — where to draw the item from
 *   storageType,   // 'shared' | 'personal' — only when source === 'structure'
 * }
 *
 * On equip:   item removed from source, placed in unit.equipment[slot].
 *             If a different item was already in the slot it is returned to group.items.
 * On unequip: item returned to group.items, slot cleared.
 */
export async function equipItem({ uid, data, db }) {
  const { worldId, tileX, tileY, groupId, unitId, slot, itemCode, source, storageType } = data;

  if (!worldId || typeof tileX !== 'number' || typeof tileY !== 'number') {
    throw err(400, 'worldId, tileX, tileY are required');
  }
  if (!groupId || !unitId || !slot) throw err(400, 'groupId, unitId, slot are required');
  if (!EQUIPMENT_SLOTS[slot]) throw err(400, `Unknown slot: ${slot}`);

  const chunkKey = getChunkKey(tileX, tileY);
  const tileKey  = `${tileX},${tileY}`;

  const chunkDoc = await db.collection('chunks').findOne({ worldId, chunkKey });
  const tile     = chunkDoc?.tiles?.[tileKey] || {};
  const groups   = tile.groups || {};
  const group    = groups[groupId];

  if (!group)                    throw err(404, 'Group not found');
  if (group.owner !== uid)       throw err(403, 'You do not own this group');
  if (!group.units?.[unitId])    throw err(404, 'Unit not found in group');

  // Deep-copy to avoid mutating the raw DB object
  const updatedGroups = JSON.parse(JSON.stringify(groups));
  const updatedGroup  = updatedGroups[groupId];
  const updatedUnit   = updatedGroup.units[unitId];

  if (!updatedUnit.equipment) updatedUnit.equipment = {};

  const currentlyEquipped = updatedUnit.equipment[slot] || null;

  const ops = new Ops();

  if (itemCode) {
    // --- Equipping ---
    const itemDef = ITEMS[itemCode];
    if (!itemDef)                       throw err(404, `Unknown item: ${itemCode}`);
    if (itemDef.equipSlot !== slot)     throw err(400, `${itemDef.name} goes in the ${itemDef.equipSlot} slot`);

    if (source === 'group') {
      const groupItems = updatedGroup.items;
      if (!groupItems || typeof groupItems !== 'object' || Array.isArray(groupItems)) {
        throw err(400, 'Unsupported item storage format');
      }
      const have = groupItems[itemCode] || 0;
      if (have < 1) throw err(409, `${itemDef.name} not available in group`);
      if (have <= 1) delete groupItems[itemCode];
      else           groupItems[itemCode] = have - 1;

    } else if (source === 'structure') {
      const structure = tile.structure;
      if (!structure) throw err(404, 'No structure at this tile');

      if (storageType === 'personal') {
        const bank = structure.banks?.[uid];
        if (!bank || typeof bank !== 'object' || Array.isArray(bank)) {
          throw err(404, 'Personal bank not found or empty');
        }
        const have = bank[itemCode] || 0;
        if (have < 1) throw err(409, `${itemDef.name} not available in personal bank`);
        const newQty = have - 1;
        if (newQty <= 0) {
          ops.chunk(worldId, chunkKey, `${tileKey}.structure.banks.${uid}.${itemCode}`, null);
        } else {
          ops.chunk(worldId, chunkKey, `${tileKey}.structure.banks.${uid}.${itemCode}`, newQty);
        }
      } else {
        // shared storage
        const sItems = structure.items;
        if (!sItems || typeof sItems !== 'object' || Array.isArray(sItems)) {
          throw err(409, `${itemDef.name} not available in shared storage`);
        }
        const have = sItems[itemCode] || 0;
        if (have < 1) throw err(409, `${itemDef.name} not available in shared storage`);
        const newQty = have - 1;
        if (newQty <= 0) {
          ops.chunk(worldId, chunkKey, `${tileKey}.structure.items.${itemCode}`, null);
        } else {
          ops.chunk(worldId, chunkKey, `${tileKey}.structure.items.${itemCode}`, newQty);
        }
      }
    } else {
      throw err(400, 'source must be "group" or "structure"');
    }

    updatedUnit.equipment[slot] = itemCode;

  } else {
    // --- Unequipping ---
    if (!currentlyEquipped) throw err(409, `Slot ${slot} is already empty`);
    delete updatedUnit.equipment[slot];
  }

  // Return displaced item (swap or unequip) to group inventory
  if (currentlyEquipped) {
    if (!updatedGroup.items || typeof updatedGroup.items !== 'object' || Array.isArray(updatedGroup.items)) {
      updatedGroup.items = {};
    }
    updatedGroup.items[currentlyEquipped] = (updatedGroup.items[currentlyEquipped] || 0) + 1;
  }

  ops.chunk(worldId, chunkKey, `${tileKey}.groups`, updatedGroups);
  await ops.flush(db);

  return { success: true, slot, equipped: itemCode || null };
}

export default equipItem;
