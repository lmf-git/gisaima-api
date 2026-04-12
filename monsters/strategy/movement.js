import {
  calculateSimplePath,
  calculateDistance,
  findAdjacentStructures,
  createMonsterMoveMessage,
  isWaterTile,
  canTraverseWater,
  canTraverseLand
} from '../_monsters.mjs';

import { joinExistingBattle } from '../strategy/combat.mjs';

import { STRUCTURES } from 'gisaima-shared/definitions/STRUCTURES.js';
import { calculateGroupPower } from "gisaima-shared/war/battles.js";

// Re-export imported functions
export { calculateSimplePath, calculateDistance, findAdjacentStructures, createMonsterMoveMessage };

// Constants
const MAX_SCAN_DISTANCE = 35; // How far to scan for targets (increased from 20)

/**
 * Move monster group towards a strategic target
 * @param {object} db - Firebase database reference
 * @param {string} worldId - World ID
 * @param {object} monsterGroup - The monster group data
 * @param {object} location - Current location coordinates
 * @param {object} worldScan - World scan data with strategic locations
 * @param {object} ops - Ops instance for batched updates
 * @param {number} now - Current timestamp
 * @param {string} targetIntent - Optional intent of movement
 * @param {object} personality - Optional personality data
 * @param {object} chunks - Optional pre-loaded chunks data
 * @param {object} terrainGenerator - TerrainGenerator instance
 * @returns {object} Action result
 */
export async function moveMonsterTowardsTarget(
  db, worldId, monsterGroup, location, worldScan, ops, now, targetIntent = null, personality = null, chunks = null, terrainGenerator = null
) {
  // SAFETY CHECK: Only move monsters that are idle or can be moved
  if (monsterGroup.status !== 'idle') {
    console.log(`Cannot move monster group ${monsterGroup.id} with status: ${monsterGroup.status}. Movement requires idle status.`);
    return {
      action: 'none',
      reason: `monster_busy_${monsterGroup.status}`
    };
  }

  const totalUnits = monsterGroup.units ? Object.keys(monsterGroup.units).length : 1;
  const tileKey = `${location.x},${location.y}`;
  const chunkKey = monsterGroup.chunkKey;
  const groupId = monsterGroup.id;

  // Check for battles on the current tile
  let hasBattles = false;

  if (chunks && chunks[chunkKey] && chunks[chunkKey][tileKey] &&
      chunks[chunkKey][tileKey].battles &&
      Object.keys(chunks[chunkKey][tileKey].battles).length > 0) {
    hasBattles = true;
  }

  // Check if monster is in exploration phase using tick counting
  const inExplorationPhase = monsterGroup.explorationPhase &&
                           (monsterGroup.explorationTicks && monsterGroup.explorationTicks > 0);

  // If there are battles, 75% chance to join instead of moving (unless we're in exploration phase)
  if (hasBattles && !inExplorationPhase && Math.random() < 0.75) {
    console.log(`Monster group ${monsterGroup.id} will try to join battle instead of moving.`);

    if (chunks && chunks[chunkKey] && chunks[chunkKey][tileKey]) {
      return await joinExistingBattle(db, worldId, monsterGroup, chunks[chunkKey][tileKey], ops, now);
    }
  }

  // Get personality weights or use defaults
  const weights = personality?.weights || { explore: 1.0, attack: 1.0 };

  let targetLocation;
  let targetType;
  let targetDistance = Infinity;

  // Decrement exploration ticks if in exploration phase
  if (inExplorationPhase) {
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.explorationTicks`, (monsterGroup.explorationTicks || 1) - 1);

    // If this is the last exploration tick, clear the phase
    if (monsterGroup.explorationTicks <= 1) {
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.explorationPhase`, false);
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.explorationTicks`, null);
    }
  }

  // First priority: Check for targetStructure (for monsters specifically mobilized to attack)
  if (monsterGroup.targetStructure && !targetLocation) {
    targetLocation = monsterGroup.targetStructure;
    targetType = 'player_structure_attack';
    targetDistance = calculateDistance(location, targetLocation);
    console.log(`Monster group ${monsterGroup.id} targeting player structure at (${targetLocation.x}, ${targetLocation.y})`);
  }

  // Check if monster was recently mobilized and is in exploration phase
  if (inExplorationPhase && monsterGroup.mobilizedFromStructure) {
    const sourceStructure = worldScan.monsterStructures.find(s =>
      s.structure && s.structure.id === monsterGroup.mobilizedFromStructure);

    if (sourceStructure) {
      // Move away from source structure - prioritize player spawns
      if (worldScan.playerSpawns && worldScan.playerSpawns.length > 0) {
        // Sort player spawns by distance (closest first)
        const sortedSpawns = [...worldScan.playerSpawns].sort((a, b) => {
          const distA = calculateDistance(location, a);
          const distB = calculateDistance(location, b);
          return distA - distB;
        });

        // Pick one of the closest three, with preference to closer ones
        const targetIndex = Math.floor(Math.random() * Math.min(3, sortedSpawns.length));
        const targetSpawn = sortedSpawns[targetIndex];

        targetLocation = targetSpawn;
        targetType = 'player_spawn';
        targetDistance = calculateDistance(location, targetSpawn);

        console.log(`Monster in exploration phase targeting player spawn at (${targetSpawn.x}, ${targetSpawn.y})`);
      }
      // If no player spawns, fall through to other target options
    }
  }

  // Check if there are any structures on adjacent tiles to attack
  const adjacentCheckChance = weights.attack || 1.0;
  if (!targetLocation && Math.random() < adjacentCheckChance) {
    const adjacentStructure = await findAdjacentStructures(db, worldId, location, chunks);
    if (adjacentStructure) {
      if (adjacentStructure.structure && !adjacentStructure.structure.monster) {
        return moveOneStepTowardsTarget(worldId, monsterGroup, location, adjacentStructure, 'structure_attack', ops, now, chunks, terrainGenerator);
      }
      if (adjacentStructure.hasPlayerGroups) {
        return moveOneStepTowardsTarget(worldId, monsterGroup, location, adjacentStructure, 'player_group_attack', ops, now, chunks, terrainGenerator);
      }
    }
  }

  // If this monster group has a preferredStructureId (their "home"), prioritize it
  // But SKIP this if the monster is in exploration phase
  const homePreferenceWeight = personality?.id === 'TERRITORIAL' ? 2.0 : 1.0;
  if (!targetLocation &&
      !inExplorationPhase &&
      monsterGroup.preferredStructureId &&
      Math.random() < homePreferenceWeight) {
    const preferredStructure = worldScan.monsterStructures.find(s =>
      s.structure && s.structure.id === monsterGroup.preferredStructureId);

    if (preferredStructure) {
      targetLocation = preferredStructure;
      targetType = 'monster_home';
      targetDistance = calculateDistance(location, preferredStructure);
    }
  }

  // Modified target selection based on personality and exploration phase
  if (!targetLocation || targetDistance > MAX_SCAN_DISTANCE) {
    const priorityMap = calculateMovementPriorities(weights, totalUnits, worldScan, inExplorationPhase, monsterGroup);

    const targetChoice = chooseTargetLocation(location, priorityMap);
    if (targetChoice) {
      targetLocation = targetChoice.location;
      targetType = targetChoice.type;
      targetDistance = targetChoice.distance;
    }
  }

  // If no suitable target found or too far, choose a random direction with purpose
  if (!targetLocation || targetDistance > MAX_SCAN_DISTANCE) {
    let dirX = Math.floor(Math.random() * 3) - 1;
    let dirY = Math.floor(Math.random() * 3) - 1;

    if (personality?.id) {
      if (personality.id === 'NOMADIC') {
        if (Math.random() < 0.7) {
          if (dirX === 0 && dirY === 0) {
            dirX = Math.random() < 0.5 ? 1 : -1;
          }
          if (Math.random() < 0.6) {
            if (Math.abs(dirX) > Math.abs(dirY)) {
              dirY = 0;
            } else {
              dirX = 0;
            }
          }
        }
      } else if (personality.id === 'TERRITORIAL') {
        const angle = Math.random() * 2 * Math.PI;
        dirX = Math.cos(angle);
        dirY = Math.sin(angle);
      } else if (personality.id === 'AGGRESSIVE') {
        if (Math.random() < 0.4) {
          dirX = location.x > 0 ? -1 : 1;
          dirY = location.y > 0 ? -1 : 1;
        }
      }
    }

    const explorationDistance = personality?.id === 'NOMADIC' ? 5 :
                           personality?.id === 'CAUTIOUS' ? 2 : 3;

    targetLocation = {
      x: location.x + Math.round(dirX * explorationDistance),
      y: location.y + Math.round(dirY * explorationDistance)
    };
    targetType = 'exploration';
    targetDistance = calculateDistance(location, targetLocation);
  }

  // Check if target is reachable (not water, or monster can traverse water)
  if (targetLocation && terrainGenerator) {
    const targetTerrainData = terrainGenerator.getTerrainData(targetLocation.x, targetLocation.y);

    const isWater = (targetTerrainData.biome && targetTerrainData.biome.water) ||
                   targetTerrainData.riverValue > 0.2 ||
                   targetTerrainData.lakeValue > 0.2;

    if (isWater && !canTraverseWater(monsterGroup)) {
      console.log(`Target at (${targetLocation.x},${targetLocation.y}) is water and monster can't traverse it. Finding new target.`);

      const maxSearchRadius = 5;
      let foundLand = false;

      for (let radius = 1; radius <= maxSearchRadius && !foundLand; radius++) {
        for (let dx = -radius; dx <= radius && !foundLand; dx++) {
          for (let dy = -radius; dy <= radius && !foundLand; dy++) {
            if (Math.abs(dx) === radius || Math.abs(dy) === radius) {
              const checkX = targetLocation.x + dx;
              const checkY = targetLocation.y + dy;

              const checkTerrain = terrainGenerator.getTerrainData(checkX, checkY);

              if ((!checkTerrain.biome || !checkTerrain.biome.water) &&
                  checkTerrain.riverValue <= 0.2 &&
                  checkTerrain.lakeValue <= 0.2) {
                targetLocation = { x: checkX, y: checkY };
                foundLand = true;
                console.log(`Found nearby land at (${checkX}, ${checkY})`);
                break;
              }
            }
          }
        }
      }

      if (!foundLand) {
        targetLocation = null;
        targetType = null;
        targetDistance = Infinity;
      }
    }
  }

  // If target is more than 1 tile away, move only 1 tile in that direction
  if (targetDistance > 1.5) {
    return moveOneStepTowardsTarget(worldId, monsterGroup, location, targetLocation, targetType, ops, now, chunks, terrainGenerator);
  }

  // Calculate a path to the target using a randomized step count for more varied monster movement
  const randomMaxSteps = 1 + Math.floor(Math.random() * 3);
  const path = calculateWaterAwarePath(
    location.x, location.y,
    targetLocation.x, targetLocation.y,
    randomMaxSteps,
    monsterGroup,
    terrainGenerator
  );

  // Check if path was blocked by terrain
  if (wasPathBlockedByTerrain(path)) {
    const blockedAt = getPathBlockedCoordinates(path);
    console.log(`Monster path to ${targetType} was blocked by terrain at (${blockedAt.x}, ${blockedAt.y})`);

    if (path.length <= 1) {
      console.log(`Cannot make progress to target, finding alternative...`);

      const randomDirX = Math.floor(Math.random() * 3) - 1;
      const randomDirY = Math.floor(Math.random() * 3) - 1;
      const explorationDistance = personality?.id === 'NOMADIC' ? 4 : 2;

      targetLocation = {
        x: location.x + randomDirX * explorationDistance,
        y: location.y + randomDirY * explorationDistance
      };
      targetType = 'exploration';

      return moveOneStepTowardsTarget(worldId, monsterGroup, location, targetLocation, targetType, ops, now, chunks, terrainGenerator);
    }
  }

  // Movement speed can depend on personality
  let moveSpeed = personality?.id === 'NOMADIC' ? 1.3 :
                 personality?.id === 'CAUTIOUS' ? 0.8 : 1;

  if (inExplorationPhase) {
    moveSpeed *= 1.2;
  }

  const movementUpdates = {
    status: 'moving',
    movementPath: path,
    pathIndex: 0,
    moveStarted: now,
    moveSpeed: moveSpeed,
    nextMoveTime: now + 60000
  };

  // Set the entire movement data object at once
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}`, {
    ...monsterGroup,
    ...movementUpdates
  });

  // Add chat message for significant monster movements
  const chatMessage = createMonsterMoveMessage(monsterGroup, targetType, targetLocation);

  ops.chat(worldId, {
    text: chatMessage,
    type: 'event',
    category: 'monster',
    timestamp: now,
    location: {
      x: location.x,
      y: location.y
    }
  });

  return {
    action: 'move',
    target: {
      type: targetType,
      x: targetLocation.x,
      y: targetLocation.y,
      distance: targetDistance
    }
  };
}

/**
 * Calculate movement priorities based on personality and state
 */
function calculateMovementPriorities(weights, totalUnits, worldScan, inExplorationPhase = false, monsterGroup = null) {
  const priorities = {
    monster_structure: {
      weight: 0.5,
      locations: worldScan.monsterStructures || [],
      maxDistance: MAX_SCAN_DISTANCE * 1.2
    },
    resource_hotspot: {
      weight: 0.5,
      locations: worldScan.resourceHotspots || [],
      maxDistance: MAX_SCAN_DISTANCE
    },
    player_spawn: {
      weight: 1.2,
      locations: worldScan.playerSpawns || [],
      maxDistance: MAX_SCAN_DISTANCE * 2.0
    },
    player_structure: {
      weight: 1.0,
      locations: worldScan.playerStructures || [],
      maxDistance: MAX_SCAN_DISTANCE * 1.5
    }
  };

  if (monsterGroup) {
    const monsterPower = calculateGroupPower(monsterGroup);
    const personalityId = monsterGroup.personality?.id || 'BALANCED';

    if (priorities.player_spawn.locations.length > 0) {
      priorities.player_spawn.locations = priorities.player_spawn.locations.filter(location => {
        if (location.structure && location.structure.type) {
          const structureType = location.structure.type;
          const structurePower = STRUCTURES[structureType]?.durability || 100;
          const powerThreshold = personalityId === 'AGGRESSIVE' ? 0.4 :
                               personalityId === 'FERAL' ? 0.05 : 0.6;

          if (personalityId === 'AGGRESSIVE' || personalityId === 'FERAL') {
            if (monsterPower < 20 && Math.random() < 0.5) {
              return true;
            }
          }

          return monsterPower >= structurePower * powerThreshold;
        }
        return true;
      });
    }

    if (priorities.player_structure.locations.length > 0) {
      priorities.player_structure.locations = priorities.player_structure.locations.filter(location => {
        if (location.structure && location.structure.type) {
          const structureType = location.structure.type;
          const structurePower = STRUCTURES[structureType]?.durability || 100;
          const powerThreshold = personalityId === 'AGGRESSIVE' ? 0.4 :
                               personalityId === 'FERAL' ? 0.05 : 0.6;

          if (personalityId === 'AGGRESSIVE' || personalityId === 'FERAL') {
            if (monsterPower < 20 && Math.random() < 0.3) {
              return true;
            }
          }

          return monsterPower >= structurePower * powerThreshold;
        }
        return true;
      });
    }

    if ((personalityId === 'AGGRESSIVE' || personalityId === 'FERAL') &&
        monsterPower < 40) {
      priorities.monster_groups = {
        weight: 1.8,
        locations: worldScan.monsterGroups || [],
        maxDistance: MAX_SCAN_DISTANCE * 1.5
      };
    }
  }

  if (weights) {
    if (weights.attack > 1.0) {
      priorities.player_spawn.weight *= weights.attack * 2.0;
      priorities.player_structure.weight *= weights.attack * 1.8;

      if (weights.attack > 1.5 && totalUnits > 8) {
        priorities.player_spawn.weight *= 1.5;
      }
    }

    if (weights.gather > 1.0) {
      priorities.resource_hotspot.weight *= weights.gather;
    }

    if (weights.build > 1.0) {
      priorities.monster_structure.weight *= weights.build;
    }
  }

  if (totalUnits > 10) {
    priorities.player_spawn.weight *= 2.0;
  } else if (totalUnits < 5) {
    priorities.resource_hotspot.weight *= 1.3;
  }

  if (inExplorationPhase) {
    priorities.player_spawn.weight *= 4.0;
    priorities.resource_hotspot.weight *= 0.8;
    priorities.monster_structure.weight *= 0.1;
  }

  return priorities;
}

/**
 * Choose a target location based on weighted priorities
 */
function chooseTargetLocation(currentLocation, priorityMap) {
  const allTargets = [];

  for (const [type, data] of Object.entries(priorityMap)) {
    for (const location of data.locations) {
      const distance = calculateDistance(currentLocation, location);
      if (distance < data.maxDistance) {
        const distanceFactor = 1 - (distance / data.maxDistance);
        const weight = data.weight * distanceFactor;

        allTargets.push({
          type,
          location,
          distance,
          weight
        });
      }
    }
  }

  if (allTargets.length === 0) return null;

  const totalWeight = allTargets.reduce((sum, target) => sum + target.weight, 0);
  let randomValue = Math.random() * totalWeight;

  for (const target of allTargets) {
    randomValue -= target.weight;
    if (randomValue <= 0) {
      return target;
    }
  }

  return allTargets[0];
}

/**
 * Calculate a path that respects the monster's terrain traversal capabilities
 */
function calculateWaterAwarePath(startX, startY, endX, endY, maxSteps, monsterGroup, terrainGenerator) {
  if (!terrainGenerator) {
    return calculateSimplePath(startX, startY, endX, endY, maxSteps);
  }

  if (startX === endX && startY === endY) {
    return [{x: startX, y: startY}];
  }

  const path = [{x: startX, y: startY}];

  const isWaterOnly = monsterGroup.motion &&
                    monsterGroup.motion.includes('water') &&
                    !canTraverseLand(monsterGroup);

  const dx = Math.abs(endX - startX);
  const dy = Math.abs(endY - startY);
  const sx = startX < endX ? 1 : -1;
  const sy = startY < endY ? 1 : -1;

  let err = dx - dy;
  let x = startX;
  let y = startY;

  let stepsLeft = Math.min(maxSteps, dx + dy);

  while ((x !== endX || y !== endY) && stepsLeft > 0) {
    const e2 = 2 * err;

    let nextX = x;
    if (e2 > -dy) {
      nextX = x + sx;
    }

    let nextY = y;
    if (e2 < dx) {
      nextY = y + sy;
    }

    if (terrainGenerator) {
      const isWater = isWaterTile(nextX, nextY, terrainGenerator);

      if ((isWater && !canTraverseWater(monsterGroup)) ||
          (!isWater && isWaterOnly)) {
        console.log(`Path for monster group terminated at (${x},${y}) due to incompatible terrain (Water: ${isWater ? 'Yes' : 'No'})`);

        path.pathBlockedByTerrain = true;
        path.blockedAtCoordinates = {x, y};

        return path;
      }
    }

    if (e2 > -dy) {
      err -= dy;
      x = nextX;
    }

    if (e2 < dx) {
      err += dx;
      y = nextY;
    }

    path.push({x, y});
    stepsLeft--;
  }

  return path;
}

/**
 * Move one step towards a target location
 */
export function moveOneStepTowardsTarget(worldId, monsterGroup, location, targetLocation, targetType, ops, now, chunks, terrainGenerator = null) {
  // SAFETY CHECK: Only move monsters that are idle
  if (monsterGroup.status !== 'idle') {
    console.log(`Cannot move monster group ${monsterGroup.id} with status: ${monsterGroup.status}. Movement requires idle status.`);
    return {
      action: 'none',
      reason: `monster_busy_${monsterGroup.status}`
    };
  }

  const chunkKey = monsterGroup.chunkKey;
  const tileKey = monsterGroup.tileKey;
  const groupId = monsterGroup.id;

  const dx = targetLocation.x - location.x;
  const dy = targetLocation.y - location.y;

  // Check if monster is already at target location to prevent NaN values
  if (dx === 0 && dy === 0) {
    console.log(`Monster group ${groupId} is already at target location (${location.x}, ${location.y})`);

    const randomDirX = Math.floor(Math.random() * 3) - 1;
    const randomDirY = Math.floor(Math.random() * 3) - 1;

    if (randomDirX === 0 && randomDirY === 0) {
      return {
        action: 'idle',
        reason: 'already_at_target'
      };
    }

    const newTargetX = location.x + randomDirX;
    const newTargetY = location.y + randomDirY;

    console.log(`Choosing random direction (${randomDirX},${randomDirY}) to avoid staying in place`);

    const path = [
      { x: location.x, y: location.y },
      { x: newTargetX, y: newTargetY }
    ];

    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}`, {
      ...monsterGroup,
      status: 'moving',
      movementPath: path,
      pathIndex: 0,
      moveStarted: now,
      moveSpeed: 1,
      nextMoveTime: now + 60000
    });

    return {
      action: 'move',
      target: {
        type: 'random_exploration',
        x: newTargetX,
        y: newTargetY,
        distance: 1
      }
    };
  }

  // Calculate the direction to move (normalize to get a unit vector)
  const length = Math.sqrt(dx * dx + dy * dy);
  const dirX = dx / length;
  const dirY = dy / length;

  let nextX = location.x + Math.round(dirX);
  let nextY = location.y + Math.round(dirY);

  const isWaterOnly = monsterGroup.motion &&
                    monsterGroup.motion.includes('water') &&
                    !canTraverseLand(monsterGroup);

  let isNextPositionWater = false;
  let isValidTerrain = true;

  if (terrainGenerator) {
    isNextPositionWater = isWaterTile(nextX, nextY, terrainGenerator);

    if ((isNextPositionWater && !canTraverseWater(monsterGroup)) ||
        (!isNextPositionWater && isWaterOnly)) {
      isValidTerrain = false;
    }
  } else if (chunks) {
    const nextChunkKey = getChunkKey(nextX, nextY);
    const nextTileKey = `${nextX},${nextY}`;

    if (chunks[nextChunkKey] && chunks[nextChunkKey][nextTileKey]) {
      const tileData = chunks[nextChunkKey][nextTileKey];
      isNextPositionWater = tileData.biome?.water === true;

      if ((isNextPositionWater && !canTraverseWater(monsterGroup)) ||
          (!isNextPositionWater && isWaterOnly)) {
        isValidTerrain = false;
      }
    }
  }

  if (!isValidTerrain) {
    const alternatives = [
      { x: location.x + 1, y: location.y },
      { x: location.x - 1, y: location.y },
      { x: location.x, y: location.y + 1 },
      { x: location.x, y: location.y - 1 },
      { x: location.x + 1, y: location.y + 1 },
      { x: location.x + 1, y: location.y - 1 },
      { x: location.x - 1, y: location.y + 1 },
      { x: location.x - 1, y: location.y - 1 }
    ];

    alternatives.sort(() => Math.random() - 0.5);

    let foundAlternative = false;
    for (const alt of alternatives) {
      let isAltWater = false;

      if (terrainGenerator) {
        isAltWater = isWaterTile(alt.x, alt.y, terrainGenerator);

        if ((isWaterOnly && isAltWater) || (!isWaterOnly && !isAltWater)) {
          nextX = alt.x;
          nextY = alt.y;
          foundAlternative = true;
          break;
        }
      } else if (chunks) {
        const altChunkKey = getChunkKey(alt.x, alt.y);
        const altTileKey = `${alt.x},${alt.y}`;

        if (chunks[altChunkKey] && chunks[altChunkKey][altTileKey]) {
          const altTileData = chunks[altChunkKey][altTileKey];
          isAltWater = altTileData.biome?.water === true;

          if ((isWaterOnly && isAltWater) || (!isWaterOnly && !isAltWater)) {
            nextX = alt.x;
            nextY = alt.y;
            foundAlternative = true;
            break;
          }
        }
      }
    }

    if (!foundAlternative) {
      let randomDirX = Math.floor(Math.random() * 3) - 1;
      let randomDirY = Math.floor(Math.random() * 3) - 1;

      if (randomDirX === 0 && randomDirY === 0) {
        randomDirX = Math.random() < 0.5 ? 1 : -1;
      }

      nextX = location.x + randomDirX;
      nextY = location.y + randomDirY;

      console.log(`Monster group ${groupId} is trying random direction (${randomDirX},${randomDirY}) after terrain blockage.`);
    }
  }

  // Create a simple two-point path
  const path = [
    { x: location.x, y: location.y },
    { x: nextX, y: nextY }
  ];

  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}`, {
    ...monsterGroup,
    status: 'moving',
    movementPath: path,
    pathIndex: 0,
    moveStarted: now,
    moveSpeed: 1,
    nextMoveTime: now + 60000
  });

  // Add chat message for monster movement if it's a significant target
  if (['player_spawn', 'monster_structure', 'monster_home'].includes(targetType)) {
    ops.chat(worldId, {
      text: `${monsterGroup.name || "Monster group"} is moving towards ${targetType === 'player_spawn' ? 'a settlement' : 'their lair'}.`,
      type: 'event',
      timestamp: now,
      location: {
        x: location.x,
        y: location.y
      }
    });
  }

  return {
    action: 'move',
    target: {
      type: targetType,
      x: nextX,
      y: nextY,
      distance: 1
    }
  };
}

/**
 * Utility function to check if a path was terminated due to terrain incompatibility
 */
function wasPathBlockedByTerrain(path) {
  return path && path.pathBlockedByTerrain === true;
}

/**
 * Get the coordinates where a path was blocked
 */
function getPathBlockedCoordinates(path) {
  return (path && path.pathBlockedByTerrain) ? path.blockedAtCoordinates : null;
}

// Helper function to get chunk key from coordinates
function getChunkKey(x, y) {
  const chunkX = Math.floor(x / 20);
  const chunkY = Math.floor(y / 20);
  return `${chunkX},${chunkY}`;
}

/**
 * Evaluate if a moving monster should interrupt its current path based on detected opportunities
 * @param {Object} monsterGroup - Monster group data
 * @param {Object} tileData - Current tile data
 * @param {Object} worldScan - World scan data
 * @param {Object} currentLocation - Current location coordinates
 * @returns {Object} Decision object with shouldInterrupt flag and reason
 */
export function shouldInterruptMovement(monsterGroup, tileData, worldScan, currentLocation) {
  // Don't interrupt if the monster just started moving (avoid oscillating behavior)
  if (monsterGroup.moveStarted && Date.now() - monsterGroup.moveStarted < 30000) {
    return { shouldInterrupt: false };
  }

  const personalityId = monsterGroup.personality?.id || 'BALANCED';
  const unitCount = monsterGroup.units ? Object.keys(monsterGroup.units).length : 0;

  let combatThreshold = 0.5;
  let resourceThreshold = 0.4;
  let structureThreshold = 0.6;

  switch (personalityId) {
    case 'AGGRESSIVE':
      combatThreshold = 0.2;
      resourceThreshold = 0.7;
      structureThreshold = 0.5;
      break;
    case 'FERAL':
      combatThreshold = 0.1;
      resourceThreshold = 0.6;
      structureThreshold = 0.5;
      break;
    case 'TERRITORIAL':
      combatThreshold = 0.4;
      resourceThreshold = 0.5;
      structureThreshold = 0.3;
      break;
    case 'CAUTIOUS':
      combatThreshold = 0.8;
      resourceThreshold = 0.3;
      structureThreshold = 0.7;
      break;
    case 'NOMADIC':
      combatThreshold = 0.6;
      resourceThreshold = 0.2;
      structureThreshold = 0.7;
      break;
  }

  // Check for player groups on tile (combat opportunity)
  if (tileData.groups) {
    const playerGroups = Object.values(tileData.groups).filter(g =>
      g.type !== 'monster' && g.status === 'idle'
    );

    if (playerGroups.length > 0 && Math.random() > combatThreshold) {
      return {
        shouldInterrupt: true,
        reason: 'player_groups_detected',
        opportunity: 'combat'
      };
    }
  }

  // Check for battles on tile (join opportunity)
  if (tileData.battles && Object.keys(tileData.battles).length > 0 && Math.random() > combatThreshold) {
    return {
      shouldInterrupt: true,
      reason: 'battle_detected',
      opportunity: 'join_battle'
    };
  }

  // Check for player structures on tile (structure attack opportunity)
  if (tileData.structure && !tileData.structure.monster && Math.random() > structureThreshold) {
    return {
      shouldInterrupt: true,
      reason: 'player_structure_detected',
      opportunity: 'structure_attack'
    };
  }

  // Check for resource hotspots (gathering opportunity) - only if not aggressive
  if (personalityId !== 'AGGRESSIVE' && personalityId !== 'FERAL') {
    if (tileData.resources && Math.random() > resourceThreshold) {
      return {
        shouldInterrupt: true,
        reason: 'resources_detected',
        opportunity: 'gather'
      };
    }
  }

  return { shouldInterrupt: false };
}
