/**
 * Monster building strategy functions for Gisaima
 * Handles monster construction and upgrading of structures and buildings
 */

import { STRUCTURES } from 'gisaima-shared/definitions/STRUCTURES.js';
import { BUILDINGS } from 'gisaima-shared/definitions/BUILDINGS.js';
import {
  canStructureBeUpgraded,
  hasSufficientResources,
  consumeResourcesFromItems,
  createMonsterConstructionMessage,
  generateMonsterId,
  isSuitableForMonsterBuilding,
  isWaterTile
} from '../_monsters.mjs';


const MIN_UNITS_FOR_BUILDING = 3;
const MAX_MONSTER_STRUCTURES_NEARBY = 3; // Maximum number of monster structures allowed in nearby area
const NEARBY_DISTANCE = 10; // Distance considered "nearby" for structure density check

/**
 * Check if a location is suitable for building
 * @param {object} db - Firebase database reference
 * @param {string} worldId - World ID
 * @param {object} location - Location to check
 * @param {object} worldScan - World scan data
 * @param {object} chunks - Pre-loaded chunks data
 * @returns {Promise<boolean>} True if the location is suitable
 */
async function isLocationSuitableForBuilding(db, worldId, location, worldScan, chunks, terrainGenerator = null) {
  // Get the chunk and tile keys
  const chunkX = Math.floor(location.x / 20);
  const chunkY = Math.floor(location.y / 20);
  const chunkKey = `${chunkX},${chunkY}`;
  const tileKey = `${location.x},${location.y}`;
  
  try {
    // Require chunks data to contain this tile
    if (!chunks || !chunks[chunkKey] || !chunks[chunkKey][tileKey]) {
      console.log(`Location ${location.x},${location.y} not found in provided chunks data`);
      return false;
    }
    
    const tileData = chunks[chunkKey][tileKey];

    // Never build on water tiles
    if (terrainGenerator && isWaterTile(location.x, location.y, terrainGenerator)) {
      return false;
    }

    // Use the comprehensive isSuitableForMonsterBuilding check
    if (!tileData || !isSuitableForMonsterBuilding(tileData)) {
      return false;
    }
    
    // Double-check the tile doesn't have a structure (defensive programming)
    if (tileData.structure) {
      console.log(`Location ${location.x},${location.y} already has a structure, cannot build`);
      return false;
    }
    
    // Check for monster groups that are already building - prevent building conflicts
    if (tileData.groups) {
      for (const groupId in tileData.groups) {
        const group = tileData.groups[groupId];
        if (group.status === 'building') {
          console.log(`Location ${location.x},${location.y} has a group already building, cannot build`);
          return false;
        }
      }
    }
    
    // Check if there are too many monster structures nearby
    let nearbyMonsterStructures = 0;
    
    if (worldScan && worldScan.monsterStructures) {
      worldScan.monsterStructures.forEach(structure => {
        const distance = Math.sqrt(
          Math.pow(structure.x - location.x, 2) + 
          Math.pow(structure.y - location.y, 2)
        );
        
        if (distance <= NEARBY_DISTANCE) {
          nearbyMonsterStructures++;
        }
      });
    }
    
    if (nearbyMonsterStructures >= MAX_MONSTER_STRUCTURES_NEARBY) {
      return false; // Too many monster structures nearby
    }
    
    // Check if we're too close to player structures (increased minimum distance)
    const playerStructures = worldScan.playerSpawns || [];
    const MIN_DISTANCE_FROM_SPAWN = 5; // Increased minimum distance
    
    for (const playerStructure of playerStructures) {
      const distance = Math.sqrt(
        Math.pow(playerStructure.x - location.x, 2) + 
        Math.pow(playerStructure.y - location.y, 2)
      );
      
      if (distance < MIN_DISTANCE_FROM_SPAWN) {
        return false; // Too close to player spawn
      }
    }
    
    return true;
  } catch (error) {
    console.error(`Error checking location for building: ${error}`);
    return false;
  }
}

/**
 * Build a monster structure
 * @param {object} db - Firebase database reference
 * @param {string} worldId - World ID
 * @param {object} monsterGroup - Monster group data
 * @param {object} location - Current location
 * @param {object} updates - Database updates object
 * @param {number} now - Current timestamp
 * @param {object} worldScan - World scan data with strategic locations
 * @param {object} chunks - Pre-loaded chunks data
 * @returns {object} Action result
 */
export async function buildMonsterStructure(db, worldId, monsterGroup, location, ops, now, worldScan = null, chunks, terrainGenerator = null) {
  // Get personality for decision making
  const personality = monsterGroup.personality || { id: 'BALANCED' };

  // Check if the monster group has enough units to build
  const unitCount = monsterGroup.units ? Object.keys(monsterGroup.units).length : 0;
  if (unitCount < MIN_UNITS_FOR_BUILDING) {
    return { action: null, reason: 'not_enough_units' };
  }

  // Use provided worldScan or create an empty one if none provided
  const scanData = worldScan || { monsterStructures: [], playerSpawns: [], resourceHotspots: [] };

  // Determine where to build
  const buildLocation = determineBuildLocation(location, scanData, personality);

  // Check if location is suitable - chunks parameter is now required
  const isSuitable = await isLocationSuitableForBuilding(db, worldId, buildLocation, scanData, chunks, terrainGenerator);
  if (!isSuitable) {
    return { action: null, reason: 'unsuitable_location' };
  }

  // Determine what to build
  const structureType = chooseStructureType(monsterGroup, personality);

  // Check if monster has resources to build
  if (!hasResourcesToBuild(monsterGroup, structureType)) {
    return { action: null, reason: 'insufficient_resources' };
  }

  // Generate structure ID
  const structureId = generateMonsterId('monster_structure', now);

  // Set up build-location references
  const buildChunkX = Math.floor(buildLocation.x / 20);
  const buildChunkY = Math.floor(buildLocation.y / 20);
  const buildChunkKey = `${buildChunkX},${buildChunkY}`;
  const buildTileKey = `${buildLocation.x},${buildLocation.y}`;

  // Get the structure definition from the shared STRUCTURES object
  const structureData = STRUCTURES[structureType];
  if (!structureData) {
    return { action: null, reason: 'invalid_structure_type' };
  }

  // Calculate completion time
  const buildTime = structureData.buildTime || 1;
  const completionTime = now + (buildTime * 60000);

  // Consume resources from the monster group (returns remaining items or null)
  const remainingItems = consumeResourcesFromItems(monsterGroup.items || {}, getRequiredResourcesForStructure(structureType));
  if (remainingItems === null) {
    return { action: null, reason: 'resource_consumption_failed' };
  }
  ops.chunk(worldId, monsterGroup.chunkKey, `${monsterGroup.tileKey}.groups.${monsterGroup.id}.items`, remainingItems);

  // Write the structure to its tile
  ops.chunk(worldId, buildChunkKey, `${buildTileKey}.structure`, {
    id: structureId,
    name: `${monsterGroup.name || 'Monster'} ${structureData.name}`,
    type: structureType,
    status: 'building',
    buildProgress: 0,
    owner: monsterGroup.id,
    ownerName: monsterGroup.name || 'Monster',
    monster: true,
    level: 1,
    items: [],
    capacity: structureData.capacity || 10
  });

  // Set monster group as building
  ops.chunk(worldId, monsterGroup.chunkKey, `${monsterGroup.tileKey}.groups.${monsterGroup.id}.status`, 'building');
  ops.chunk(worldId, monsterGroup.chunkKey, `${monsterGroup.tileKey}.groups.${monsterGroup.id}.preferredStructureId`, structureId);

  // Chat message
  ops.chat(worldId, {
    text: createMonsterConstructionMessage(monsterGroup, 'build', structureData.name, buildLocation),
    type: 'event',
    category: 'monster',
    timestamp: now,
    location: { x: location.x, y: location.y }
  });

  return {
    action: 'build',
    structureId,
    structureType,
    location: buildLocation,
    completesAt: completionTime
  };
}

/**
 * Calculate required resources for a monster structure
 * @param {string} structureType - Type of structure to build
 * @returns {Array} Array of required resources
 */
function getRequiredResourcesForStructure(structureType) {
  // Use the shared STRUCTURES definitions with standardized format
  if (STRUCTURES[structureType] && STRUCTURES[structureType].requiredResources) {
    return STRUCTURES[structureType].requiredResources;
  }
  
  // Fallback for backward compatibility
  if (STRUCTURES[structureType] && STRUCTURES[structureType].buildCost) {
    const structure = STRUCTURES[structureType];
    return Object.entries(structure.buildCost).map(([name, quantity]) => ({ 
      name, 
      quantity 
    }));
  }
  
  // Default simple requirements if structure type not found
  return [
    { name: 'Wooden Sticks', quantity: 8 },
    { name: 'Stone Pieces', quantity: 6 }
  ];
}

/**
 * Check if monster group has resources for building
 * @param {object} monsterGroup - Monster group data
 * @param {string} structureType - Structure type to build
 * @returns {boolean} True if group has required resources
 */
function hasResourcesToBuild(monsterGroup, structureType) {
  const requiredResources = getRequiredResourcesForStructure(structureType);
  return hasSufficientResources(monsterGroup.items || {}, requiredResources);
}


/**
 * Check if monster group has resources to upgrade a building
 * @param {object} monsterGroup - Monster group data
 * @param {object} structure - Structure to upgrade
 * @returns {boolean} True if group has required resources
 */
function hasResourcesToUpgrade(monsterGroup, structure) {
  if (!monsterGroup.items) {
    return false;
  }
  
  // Determine current level
  const currentLevel = structure.level || 1;
  
  // Simple resource requirements for upgrades based on level
  const requiredResources = [
    { name: 'WOODEN_STICKS', quantity: 5 * currentLevel },
    { name: 'STONE_PIECES', quantity: 3 * currentLevel }
  ];
  
  // Add special resources for higher levels
  if (currentLevel >= 2) {
    requiredResources.push({ name: 'IRON_ORE', quantity: currentLevel });
  }
  
  if (currentLevel >= 3) {
    requiredResources.push({ name: 'CRYSTAL_SHARD', quantity: 1 });
  }
  
  return hasSufficientResources(monsterGroup.items, requiredResources);
}

/**
 * Choose which structure type to build based on available resources
 * @param {object} monsterGroup - Monster group data
 * @param {object} personality - Personality data
 * @returns {string} Chosen structure type
 */
function chooseStructureType(monsterGroup, personality) {
  // Default structure types
  const structureTypes = [
    'monster_lair',
    'monster_hive',
    'monster_fortress'
  ];
  
  // Calculate weights based on personality
  const weights = {};
  
  for (const type of structureTypes) {
    weights[type] = 1.0; // Default weight
    
    // Adjust weights based on personality
    if (personality?.id === 'BUILDER') {
      // Builder personality prefers all structures
      weights[type] *= 1.5;
    } else if (personality?.id === 'TERRITORIAL') {
      // Territorial monsters prefer defensive structures
      if (type === 'monster_fortress') weights[type] *= 1.8;
    } else if (personality?.id === 'GREEDY') {
      // Greedy monsters prefer resource-storing structures
      if (type === 'monster_lair') weights[type] *= 1.3;
    } else if (personality?.id === 'AGGRESSIVE') {
      // Aggressive monsters prefer offensive structures
      if (type === 'monster_hive') weights[type] *= 1.4;
    }
    
    // If we don't have resources for this structure, set weight to 0
    if (!hasResourcesToBuild(monsterGroup, type)) {
      weights[type] = 0;
    }
  }
  
  // Find the structure type with the highest weight
  const validTypes = Object.entries(weights)
    .filter(([_, weight]) => weight > 0)
    .sort((a, b) => b[1] - a[1]);
  
  if (validTypes.length === 0) {
    return 'monster_lair'; // Default if no valid types
  }
  
  return validTypes[0][0];
}

/**
 * Find the best location for building
 * @param {object} location - Current location
 * @param {object} worldScan - World scan data
 * @param {object} personality - Monster personality
 * @returns {object} Target location for building
 */
function determineBuildLocation(location, worldScan, personality) {
  // Territorial monsters prefer building close to their current position
  if (personality?.id === 'TERRITORIAL') {
    return { x: location.x, y: location.y };
  }
  
  // Other personalities have different preferences
  // Builders might prefer locations near resources
  if (personality?.id === 'BUILDER' && worldScan.resourceHotspots?.length > 0) {
    // Find a resource hotspot that's not too far away
    const nearbyHotspots = worldScan.resourceHotspots.filter(hotspot => {
      const distance = Math.sqrt(
        Math.pow(hotspot.x - location.x, 2) + 
        Math.pow(hotspot.y - location.y, 2)
      );
      return distance < 10;
    });
    
    if (nearbyHotspots.length > 0) {
      const randomSpot = nearbyHotspots[Math.floor(Math.random() * nearbyHotspots.length)];
      return { x: randomSpot.x, y: randomSpot.y };
    }
  }
  
  // Aggressive monsters might prefer locations near player structures
  if (personality?.id === 'AGGRESSIVE' && worldScan.playerSpawns?.length > 0) {
    // Find a player structure that's not too close or too far
    const validSpawns = worldScan.playerSpawns.filter(spawn => {
      const distance = Math.sqrt(
        Math.pow(spawn.x - location.x, 2) + 
        Math.pow(spawn.y - location.y, 2)
      );
      return distance >= 5 && distance <= 15; // Not too close, not too far
    });
    
    if (validSpawns.length > 0) {
      const randomSpawn = validSpawns[Math.floor(Math.random() * validSpawns.length)];
      // Don't build directly on the spawn, but nearby
      const offsetX = Math.floor(Math.random() * 5) - 2;
      const offsetY = Math.floor(Math.random() * 5) - 2;
      return { x: randomSpawn.x + offsetX, y: randomSpawn.y + offsetY };
    }
  }
  
  // Default: build relatively close to current position
  const offsetX = Math.floor(Math.random() * 5) - 2;
  const offsetY = Math.floor(Math.random() * 5) - 2;
  return {
    x: location.x + offsetX,
    y: location.y + offsetY
  };
}

/**
 * Upgrade an existing monster structure
 * @param {object} db - Firebase database reference
 * @param {string} worldId - World ID
 * @param {object} monsterGroup - Monster group data
 * @param {object} structure - Structure to upgrade
 * @param {object} updates - Database updates object
 * @param {number} now - Current timestamp
 * @returns {object} Action result
 */
export async function upgradeMonsterStructure(db, worldId, monsterGroup, structure, ops, now) {
  // Only upgrade monster structures
  if (!structure.monster === true) {
    return { action: null, reason: 'not_monster_structure' };
  }

  // Check if the structure can be upgraded
  if (!canStructureBeUpgraded(structure)) {
    return { action: null, reason: 'max_level_reached' };
  }

  // Check if monster group has resources to upgrade
  if (!hasResourcesToUpgrade(monsterGroup, structure)) {
    return { action: null, reason: 'insufficient_resources' };
  }

  const chunkKey = monsterGroup.chunkKey;
  const tileKey = monsterGroup.tileKey;
  const groupId = monsterGroup.id;
  const currentLevel = structure.level || 1;

  // Generate resource requirements for upgrade
  const requiredResources = [
    { name: 'WOODEN_STICKS', quantity: 5 * currentLevel },
    { name: 'STONE_PIECES', quantity: 3 * currentLevel }
  ];

  if (currentLevel >= 2) {
    requiredResources.push({ name: 'IRON_ORE', quantity: currentLevel });
  }

  const remainingItems = consumeResourcesFromItems(monsterGroup.items || {}, requiredResources);
  if (remainingItems === null) {
    return { action: null, reason: 'resource_consumption_failed' };
  }

  // Update the monster group with remaining items
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.items`, remainingItems);

  // Update the structure
  const newLevel = currentLevel + 1;
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.level`, newLevel);
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.upgradeTime`, now);

  const newFeatures = [...(structure.features || [])];
  if (newLevel === 2) {
    newFeatures.push('improved_defense');
  } else if (newLevel === 3) {
    newFeatures.push('monster_recruitment');
  }
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.features`, newFeatures);

  ops.chat(worldId, {
    text: `${monsterGroup.name || "Monsters"} have upgraded their ${structure.name || "structure"} to level ${newLevel}!`,
    type: 'event',
    category: 'monster',
    timestamp: now,
    location: {
      x: parseInt(tileKey.split(',')[0]),
      y: parseInt(tileKey.split(',')[1])
    }
  });

  return {
    action: 'upgrade',
    structureId: structure.id,
    newLevel
  };
}

/**
 * Demobilize at a monster structure to deposit resources
 * @param {object} db - Firebase database reference
 * @param {string} worldId - World ID
 * @param {object} monsterGroup - Monster group data
 * @param {object} structure - Target structure
 * @param {object} updates - Database updates object
 * @param {number} now - Current timestamp
 * @returns {object} Action result
 */
export async function demobilizeAtMonsterStructure(db, worldId, monsterGroup, structure, ops, now) {
  // Only allow demobilizing at monster structures
  if (!structure.monster) {
    return { action: null, reason: 'not_monster_structure' };
  }

  const chunkKey = monsterGroup.chunkKey;
  const tileKey = monsterGroup.tileKey;
  const groupId = monsterGroup.id;

  // Check if the monster group has items to deposit
  const hasItems = monsterGroup.items && (
    (Array.isArray(monsterGroup.items) && monsterGroup.items.length > 0) ||
    (!Array.isArray(monsterGroup.items) && Object.keys(monsterGroup.items).length > 0)
  );

  if (!hasItems) {
    return { action: null, reason: 'no_items_to_deposit' };
  }

  // Merge monster group items into structure items
  let structureItems;

  if (Array.isArray(monsterGroup.items)) {
    // Legacy format: Array of item objects
    const baseItems = Array.isArray(structure.items) ? [...structure.items] : [];

    for (const item of monsterGroup.items) {
      const existingIndex = baseItems.findIndex(i => i.name === item.name && i.type === item.type);

      if (existingIndex >= 0) {
        baseItems[existingIndex].quantity = (baseItems[existingIndex].quantity || 1) + (item.quantity || 1);
      } else {
        baseItems.push({ ...item });
      }
    }

    structureItems = baseItems;
  } else {
    // New format: Object with item codes as keys
    if (Array.isArray(structure.items)) {
      // Convert structure's legacy array to object format
      structureItems = {};
      structure.items.forEach(item => {
        if (item && item.id) {
          const code = item.id.toUpperCase();
          structureItems[code] = (structureItems[code] || 0) + (item.quantity || 1);
        } else if (item && item.name) {
          const code = item.name.toUpperCase().replace(/ /g, '_');
          structureItems[code] = (structureItems[code] || 0) + (item.quantity || 1);
        }
      });
    } else if (!structure.items || typeof structure.items !== 'object') {
      structureItems = {};
    } else {
      structureItems = {...structure.items};
    }

    Object.entries(monsterGroup.items).forEach(([itemCode, quantity]) => {
      const code = itemCode.toUpperCase();
      structureItems[code] = (structureItems[code] || 0) + quantity;
    });
  }

  ops.chunk(worldId, chunkKey, `${tileKey}.structure.items`, structureItems);

  // Set group as demobilizing
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.status`, 'demobilising');
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.demobiliseStart`, now);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.targetStructureId`, structure.id);

  const location = {
    x: parseInt(tileKey.split(',')[0]),
    y: parseInt(tileKey.split(',')[1])
  };

  const itemCount = Array.isArray(monsterGroup.items)
    ? monsterGroup.items.length
    : Object.keys(monsterGroup.items).length;

  ops.chat(worldId, {
    text: `${monsterGroup.name || "Monster group"} is demobilizing at ${structure.name || 'their structure'} at (${location.x}, ${location.y}).`,
    type: 'event',
    category: 'monster',
    timestamp: now,
    location
  });

  return {
    action: 'demobilize',
    depositedItems: itemCount,
    structureId: structure.id
  };
}

/**
 * Add or upgrade a building within a monster structure
 * @param {object} db - Firebase database reference
 * @param {string} worldId - World ID
 * @param {object} monsterGroup - Monster group data
 * @param {object} structure - Parent structure
 * @param {string} buildingType - Type of building to add/upgrade 
 * @param {object} updates - Database updates object
 * @param {number} now - Current timestamp
 * @returns {object} Action result
 */
export async function addOrUpgradeMonsterBuilding(db, worldId, monsterGroup, structure, buildingType, ops, now) {
  // Verify this is a monster structure
  if (!structure.monster) {
    return { action: null, reason: 'not_monster_structure' };
  }
  
  // Get the building definition
  const buildingDef = BUILDINGS.types[buildingType];
  if (!buildingDef) {
    return { action: null, reason: 'unknown_building_type' };
  }
  
  // Check if the structure already has this building
  const existingBuilding = structure.buildings && structure.buildings[buildingType];
  const currentLevel = existingBuilding ? (existingBuilding.level || 1) : 0;
  const maxLevel = 3; // Max level for monster buildings
  
  // Check if max level reached
  if (currentLevel >= maxLevel) {
    return { action: null, reason: 'max_level_reached' };
  }
  
  // Determine if we're adding new or upgrading
  const isUpgrade = currentLevel > 0;
  
  // Calculate resource requirements
  const levelMultiplier = currentLevel + 1;
  const resources = [];
  
  // Base requirements
  if (buildingDef.baseRequirements) {
    for (const req of buildingDef.baseRequirements) {
      resources.push({
        name: req.name,
        quantity: Math.floor(req.quantity * (isUpgrade ? levelMultiplier * 0.7 : 1))
      });
    }
  } else {
    // Default requirements if none specified
    resources.push({ name: 'Wooden Sticks', quantity: Math.floor(5 * levelMultiplier) });
    resources.push({ name: 'Stone Pieces', quantity: Math.floor(3 * levelMultiplier) });
  }
  
  // Check if monster group has the required resources
  const groupItems = monsterGroup.items;
  let hasEnoughResources = true;
  
  // If items are in array format
  if (Array.isArray(groupItems)) {
    const availableResources = {};
    
    for (const item of groupItems) {
      availableResources[item.name] = (availableResources[item.name] || 0) + (item.quantity || 1);
    }
    
    for (const required of resources) {
      if (!availableResources[required.name] || availableResources[required.name] < required.quantity) {
        hasEnoughResources = false;
        break;
      }
    }
  } 
  // If items are in object format
  else if (groupItems && typeof groupItems === 'object') {
    // Convert required resources to compatible format
    for (const required of resources) {
      const resourceCode = required.name.toUpperCase().replace(/ /g, '_');
      const availableQuantity = groupItems[resourceCode] || 0;
      
      if (availableQuantity < required.quantity) {
        hasEnoughResources = false;
        break;
      }
    }
  }
  
  if (!hasEnoughResources) {
    return { action: null, reason: 'insufficient_resources' };
  }
  
  // Rest of the existing function remains unchanged...
  // ...existing code...
}

/**
 * Check if a monster group can adopt an abandoned structure
 * @param {object} db - Firebase database reference
 * @param {string} worldId - World ID
 * @param {object} monsterGroup - Monster group data
 * @param {object} structure - Structure to potentially adopt
 * @param {object} updates - Database updates object
 * @param {number} now - Current timestamp
 * @param {object} chunks - Pre-loaded chunks data
 * @returns {object} Action result
 */
export async function adoptAbandonedStructure(db, worldId, monsterGroup, structure, ops, now, chunks) {
  // Only structures that are in building status can be adopted
  if (!structure || structure.status !== 'building') {
    return { action: null, reason: 'structure_not_building' };
  }
  
  const chunkKey = monsterGroup.chunkKey;
  const tileKey = monsterGroup.tileKey;
  
  // Get tile data from chunks instead of making a database call
  const tileData = chunks?.[chunkKey]?.[tileKey];
  if (!tileData) {
    return { action: null, reason: 'tile_data_not_found' };
  }
  
  // Check if any group is already building - don't adopt if someone is already working
  if (tileData.groups) {
    const hasActiveBuilder = Object.values(tileData.groups).some(
      group => group.id !== monsterGroup.id && group.status === 'building'
    );
    
    if (hasActiveBuilder) {
      return { action: null, reason: 'has_active_builder' };
    }
  }
  
  // Don't adopt player structures unless they're monster-friendly
  if (!structure.monster) {
    // Only allow adopting player structures that are "monster-friendly" - uncommon case
    if (!structure.monsterFriendly) {
      return { action: null, reason: 'not_monster_friendly' };
    }
  }
  
  // Monsters are more likely to adopt structures of their own kind
  let adoptionChance = 0.8; // High base chance for monster structures
  
  if (!structure.monster) {
    adoptionChance = 0.2; // Much lower chance for player structures
  }
  
  // Get personality for decision making
  const personality = monsterGroup.personality || { id: 'BALANCED' };
  
  // Builder personality has higher chance to adopt
  if (personality.id === 'BUILDER') {
    adoptionChance *= 1.5;
  }
  
  // Territorial personality has higher chance to adopt nearby structures
  if (personality.id === 'TERRITORIAL') {
    // Check if this is in their "territory" - nearby their existing structures
    // This would require a worldScan to check nearby structures
    adoptionChance *= 1.3;
  }
  
  // Random chance based on adoption probability
  if (Math.random() > adoptionChance) {
    return { action: null, reason: 'random_rejection' };
  }
  
  // Set monster group as building
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${monsterGroup.id}.status`, 'building');

  // Update structure to show it's being built by this monster group
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.builder`, monsterGroup.id);
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.builderName`, monsterGroup.name || 'Monster group');

  // If it's not already a monster structure, convert it if it was abandoned by players
  if (!structure.monster) {
    const longAbandoned = structure.lastActivity && (now - structure.lastActivity > 86400000); // 24 hours
    if (longAbandoned || structure.monsterFriendly) {
      ops.chunk(worldId, chunkKey, `${tileKey}.structure.owner`, 'monster');
      ops.chunk(worldId, chunkKey, `${tileKey}.structure.ownerName`, monsterGroup.name || 'Monster group');
      structure.monster = true;
    }
  }

  const location = {
    x: parseInt(tileKey.split(',')[0]),
    y: parseInt(tileKey.split(',')[1])
  };

  const messageText = structure.monster
    ? `${monsterGroup.name || "Monster group"} has decided to continue building the ${structure.name || 'structure'} at (${location.x}, ${location.y}).`
    : `${monsterGroup.name || "Monster group"} has taken over construction of the abandoned ${structure.name || 'structure'} at (${location.x}, ${location.y})!`;

  ops.chat(worldId, {
    text: messageText,
    type: 'event',
    category: 'monster',
    timestamp: now,
    location
  });

  return {
    action: 'adopt',
    structureId: structure.id,
    structureType: structure.type,
    location
  };
}
  

// Export all necessary functions
export {
  hasResourcesToBuild,
  hasResourcesToUpgrade
};
