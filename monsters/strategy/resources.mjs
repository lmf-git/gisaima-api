/**
 * Start the monster group gathering resources
 * @param {object} db - Firebase database reference
 * @param {string} worldId - The world ID
 * @param {object} monsterGroup - The monster group data
 * @param {object} ops - Ops instance for batched updates
 * @param {number} now - Current timestamp
 * @param {object} chunks - Pre-loaded chunks data
 * @returns {object} Action result
 */
export async function startMonsterGathering(db, worldId, monsterGroup, ops, now, chunks) {
  const chunkKey = monsterGroup.chunkKey;
  const tileKey = monsterGroup.tileKey;
  const groupId = monsterGroup.id;

  // Get tile data from chunks instead of making a database call
  let biome = 'plains'; // Default biome
  if (chunks && chunkKey && tileKey) {
    const tileData = chunks[chunkKey]?.[tileKey];
    if (tileData) {
      biome = tileData.biome?.name || tileData.terrain?.biome || 'plains';
    }
  }

  // Set gathering status with tick counting
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.status`, 'gathering');
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.gatheringBiome`, biome);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.gatheringTicksRemaining`, 2);

  // Add a chat message
  ops.chat(worldId, {
    text: `${monsterGroup.name || "Monster group"} is gathering resources in the ${biome}.`,
    type: 'event',
    category: 'monster',
    timestamp: now,
    location: {
      x: parseInt(tileKey.split(',')[0]),
      y: parseInt(tileKey.split(',')[1])
    }
  });

  return {
    action: 'gather',
    biome
  };
}

/**
 * Count total resources in a monster group's items
 * @param {Array|Object} items - Items that the monster group has (array or object format)
 * @returns {number} Total count of resources (sum of all quantities)
 */
export function countTotalResources(items) {
  // If no items, return 0
  if (!items) {
    return 0;
  }

  // Handle items as object (new format)
  if (!Array.isArray(items) && typeof items === 'object') {
    return Object.values(items).reduce((total, quantity) => total + quantity, 0);
  }

  // Handle items as array (legacy format)
  if (Array.isArray(items) && items.length > 0) {
    return items.reduce((total, item) => {
      // Add the quantity of this item (default to 1 if quantity is not specified)
      return total + (item.quantity || 1);
    }, 0);
  }

  return 0;
}
