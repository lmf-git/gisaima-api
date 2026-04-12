/**
 * Monster combat strategy functions
 */

import {
  findPlayerGroupsOnTile,
  findMergeableMonsterGroups,
  createBattleActionMessage,
  generateMonsterId
} from '../_monsters.mjs';
import { calculateGroupPower } from "gisaima-shared/war/battles.js";
import { STRUCTURES } from "gisaima-shared/definitions/STRUCTURES.js";

// Re-export the imported functions
export { findPlayerGroupsOnTile, findMergeableMonsterGroups };

/**
 * Merge monster groups on the same tile
 * @param {object} db - Firebase database reference
 * @param {string} worldId - World ID
 * @param {object} monsterGroup - The current monster group
 * @param {Array} mergeableGroups - Array of other monster groups to merge with
 * @param {object} ops - Ops instance for batched updates
 * @param {number} now - Current timestamp
 * @returns {object} Action result with merged unit count
 */
export async function mergeMonsterGroupsOnTile(db, worldId, monsterGroup, mergeableGroups, ops, now) {
  if (!mergeableGroups || mergeableGroups.length === 0) {
    return { action: null };
  }

  const chunkKey = monsterGroup.chunkKey;
  const tileKey = monsterGroup.tileKey;
  const groupId = monsterGroup.id;

  // Get all units from mergeable groups
  let allUnits = {...(monsterGroup.units || {})};
  let totalUnitCount = Object.keys(allUnits).length;

  // Initialize items based on format of the current monster group's items
  let mergedItems;

  // Check if items are in object format (new) or array format (legacy)
  const currentItemsAreObject = monsterGroup.items && !Array.isArray(monsterGroup.items) && typeof monsterGroup.items === 'object';

  if (currentItemsAreObject) {
    // Start with a copy of current items as object
    mergedItems = {...(monsterGroup.items || {})};

    // Gather items from groups being merged
    for (const group of mergeableGroups) {
      if (group.units) {
        allUnits = {...allUnits, ...group.units};
        totalUnitCount += Object.keys(group.units).length;
      }

      // Add items from this group based on format
      if (group.items) {
        if (!Array.isArray(group.items) && typeof group.items === 'object') {
          // Group items are in new object format, merge directly
          Object.entries(group.items).forEach(([itemCode, quantity]) => {
            mergedItems[itemCode] = (mergedItems[itemCode] || 0) + quantity;
          });
        } else if (Array.isArray(group.items) && group.items.length > 0) {
          // Group items are in legacy array format, convert to object format
          group.items.forEach(item => {
            if (item && item.id) {
              const itemCode = item.id.toUpperCase();
              mergedItems[itemCode] = (mergedItems[itemCode] || 0) + (item.quantity || 1);
            }
          });
        }
      }

      // Mark this group for deletion
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${group.id}`, null);
    }
  } else {
    // Current items are in legacy array format, continue using array format
    let itemsToAdd = [...(monsterGroup.items || [])];

    // Gather items from groups being merged
    for (const group of mergeableGroups) {
      if (group.units) {
        allUnits = {...allUnits, ...group.units};
        totalUnitCount += Object.keys(group.units).length;
      }

      if (group.items) {
        if (Array.isArray(group.items) && group.items.length > 0) {
          // Group items are also array, simply concatenate
          itemsToAdd = [...itemsToAdd, ...group.items];
        } else if (!Array.isArray(group.items) && typeof group.items === 'object') {
          // Group items are in new object format, convert to array format
          Object.entries(group.items).forEach(([itemCode, quantity]) => {
            itemsToAdd.push({
              id: itemCode,
              quantity: quantity,
              type: 'resource'
            });
          });
        }
      }

      // Mark this group for deletion
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${group.id}`, null);
    }

    mergedItems = itemsToAdd;
  }

  // Update the current group with all units and items
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.units`, allUnits);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.items`, mergedItems);

  // Add a message about the merge
  const location = {
    x: parseInt(tileKey.split(',')[0]),
    y: parseInt(tileKey.split(',')[1])
  };

  ops.chat(worldId, {
    text: `${monsterGroup.name || 'Monster group'} has grown in strength, absorbing ${mergeableGroups.length} other monster groups!`,
    type: 'event',
    category: 'monster',
    timestamp: now,
    location
  });

  return {
    action: 'merge',
    mergedGroups: mergeableGroups.length,
    totalUnits: totalUnitCount
  };
}

/**
 * Initiate an attack on player groups
 * @param {object} db - Firebase database reference
 * @param {string} worldId - World ID
 * @param {object} monsterGroup - The monster group initiating the attack
 * @param {Array} targetGroups - Array of target player groups
 * @param {object} location - The location coordinates
 * @param {object} ops - Ops instance for batched updates
 * @param {number} now - Current timestamp
 * @returns {object} Action result
 */
export async function initiateAttackOnPlayers(db, worldId, monsterGroup, targetGroups, location, ops, now) {
  const { x, y } = location;
  const chunkKey = monsterGroup.chunkKey;
  const tileKey = `${x},${y}`;

  // NEW: Check if target groups are too powerful compared to the monster group
  const monsterPower = calculateGroupPower(monsterGroup);
  let targetPower = 0;

  // Calculate combined power of target groups
  for (const group of targetGroups) {
    targetPower += calculateGroupPower(group);
  }

  // Determine if attack should proceed based on power comparison
  const isFeral = monsterGroup.personality?.id === 'FERAL';
  const powerThreshold = isFeral ? 0.1 :
                        (monsterGroup.personality?.id === 'AGGRESSIVE' ? 0.5 : 0.7);

  if (monsterPower < targetPower * powerThreshold && !isFeral) {
    console.log(`Monster group ${monsterGroup.id} (power: ${monsterPower}) avoiding attack on stronger player groups (power: ${targetPower})`);
    return { action: null, reason: 'target_too_strong' };
  }

  if (isFeral && monsterPower < targetPower * 0.1) {
    console.log(`FERAL monster group ${monsterGroup.id} recklessly attacking despite massive power difference! (${monsterPower} vs ${targetPower})`);
  }

  // Choose which player groups to attack (up to 3)
  const targetCount = Math.min(targetGroups.length, 3);

  // Sort by group size or randomly if sizes unknown
  targetGroups.sort((a, b) => (a.units?.length || 1) - (b.units?.length || 1));

  const selectedTargets = targetGroups.slice(0, targetCount);

  // Create battle ID and prepare battle data
  const battleId = `battle_${now}_${Math.floor(Math.random() * 1000)}`;

  // Create enhanced battle object with full units data for each side
  const battleData = {
    id: battleId,
    locationX: x,
    locationY: y,
    targetTypes: ['group'],
    side1: {
      groups: {
        [monsterGroup.id]: {
          type: 'monster',
          race: monsterGroup.race || 'monster',
          units: monsterGroup.units || {}
        }
      },
      name: monsterGroup.name || 'Monster Attack Force'
    },
    side2: {
      groups: selectedTargets.reduce((obj, group) => {
        obj[group.id] = {
          type: group.type || 'player',
          race: group.race || 'unknown',
          units: group.units || {}
        };
        return obj;
      }, {}),
      name: selectedTargets.length === 1 ?
        (selectedTargets[0].name || 'Defenders') : 'Defending Forces'
    },
    tickCount: 0
  };

  // Add battle to the tile
  ops.chunk(worldId, chunkKey, `${tileKey}.battles.${battleId}`, battleData);

  // Update monster group to be in battle
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${monsterGroup.id}.battleId`, battleId);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${monsterGroup.id}.battleSide`, 1);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${monsterGroup.id}.battleRole`, 'attacker');
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${monsterGroup.id}.status`, 'fighting');

  // Update each target group to be in battle
  for (const target of selectedTargets) {
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${target.id}.battleId`, battleId);
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${target.id}.battleSide`, 2);
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${target.id}.battleRole`, 'defender');
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${target.id}.status`, 'fighting');
  }

  // Add battle start message to chat
  const targetName = selectedTargets.length > 0 ?
    (selectedTargets[0].name || `Player group ${selectedTargets[0].id.slice(-4)}`) :
    'Player groups';

  ops.chat(worldId, {
    text: createBattleActionMessage(monsterGroup, 'attack', 'player', targetName, location),
    type: 'event',
    category: 'monster',
    timestamp: now,
    location: { x, y }
  });

  return {
    action: 'attack',
    targets: selectedTargets.map(t => t.id),
    battleId
  };
}

/**
 * Initiate an attack on a player structure
 * @param {object} db - Firebase database reference
 * @param {string} worldId - World ID
 * @param {object} monsterGroup - The monster group initiating the attack
 * @param {object} structure - Target structure
 * @param {object} location - The location coordinates
 * @param {object} ops - Ops instance for batched updates
 * @param {number} now - Current timestamp
 * @returns {object} Action result
 */
export async function initiateAttackOnStructure(db, worldId, monsterGroup, structure, location, ops, now) {
  const { x, y } = location;

  // Don't attack monster structures
  if (structure.monster === true) {
    console.log("Skipping attack on monster structure");
    return { action: null, reason: 'monster_structure' };
  }

  // Check if monster is on the same tile as the structure
  const onSameTile = (
    monsterGroup.x === location.x &&
    monsterGroup.y === location.y
  );

  // Check if structure is too powerful compared to the monster group
  // BUT skip this check if the monster is already on the same tile as the structure
  if (!onSameTile) {
    const monsterPower = calculateGroupPower(monsterGroup);

    // Calculate structure power based on type and durability
    let structurePower = 0;
    if (structure.type && STRUCTURES[structure.type]) {
      structurePower = STRUCTURES[structure.type].durability || 0;

      // If structure has current health, use that instead of max durability
      if (structure.health !== undefined) {
        structurePower = structure.health;
      }
    }

    const isFeral = monsterGroup.personality?.id === 'FERAL';
    const powerThreshold = isFeral ? 0.05 :
                          (monsterGroup.personality?.id === 'AGGRESSIVE' ? 0.4 : 0.6);

    if (monsterPower < structurePower * powerThreshold && !isFeral) {
      console.log(`Monster group ${monsterGroup.id} (power: ${monsterPower}) avoiding attack on stronger structure (power: ${structurePower})`);
      return { action: null, reason: 'structure_too_strong' };
    }

    if (isFeral && monsterPower < structurePower * 0.05) {
      console.log(`FERAL monster group ${monsterGroup.id} recklessly attacking structure despite massive power difference! (${monsterPower} vs ${structurePower})`);
    }
  } else {
    console.log(`Monster group ${monsterGroup.id} attacking structure they're already on at (${x}, ${y}), ignoring power difference!`);
  }

  // Create battle ID and prepare battle data
  const battleId = `battle_${now}_${Math.floor(Math.random() * 1000)}`;

  // Create enhanced battle object with full units data
  const battleData = {
    id: battleId,
    locationX: x,
    locationY: y,
    targetTypes: ['structure'],
    structureId: structure.id,
    side1: {
      groups: {
        [monsterGroup.id]: {
          type: 'monster',
          race: monsterGroup.race || 'monster',
          units: monsterGroup.units || {}
        }
      },
      name: monsterGroup.name || 'Monster Attack Force'
    },
    side2: {
      groups: {},
      name: structure.name || 'Structure Defenses',
      structureInfo: {
        id: structure.id,
        name: structure.name || 'Structure',
        type: structure.type || 'unknown',
        owner: structure.owner || 'unknown'
      }
    },
    tickCount: 0
  };

  const chunkKey = monsterGroup.chunkKey;
  const tileKey = `${x},${y}`;

  // Add battle to the tile
  ops.chunk(worldId, chunkKey, `${tileKey}.battles.${battleId}`, battleData);

  // Update monster group to be in battle
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${monsterGroup.id}.battleId`, battleId);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${monsterGroup.id}.battleSide`, 1);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${monsterGroup.id}.battleRole`, 'attacker');
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${monsterGroup.id}.status`, 'fighting');

  // Mark structure as in battle
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.battleId`, battleId);

  // Add battle start message to chat
  const structureName = structure.name || structure.type || "Settlement";

  ops.chat(worldId, {
    text: createBattleActionMessage(monsterGroup, 'attack', 'structure', structureName, location),
    type: 'event',
    category: 'monster',
    timestamp: now,
    location: { x, y }
  });

  console.log(`Monster group ${monsterGroup.id} is attacking structure ${structure.id} (type: ${structure.type}) at (${x}, ${y})`);

  return {
    action: 'attack',
    targetStructure: structure.id,
    structureType: structure.type,
    battleId
  };
}

/**
 * Find other monster groups on tile that could be attacked
 * @param {object} tileData - Data for the current tile
 * @param {string} currentGroupId - ID of the current monster group
 * @returns {Array} Array of attackable monster groups
 */
export function findAttackableMonsterGroups(tileData, currentGroupId) {
  const monsterGroups = [];

  if (tileData.groups) {
    Object.entries(tileData.groups).forEach(([groupId, groupData]) => {
      // Check if it's another monster group (and not the current one) that's not in battle
      if (groupId !== currentGroupId &&
          groupData.type === 'monster' &&
          (groupData.status === 'idle' || groupData.status === 'moving')) {
        monsterGroups.push({
          id: groupId,
          ...groupData
        });
      }
    });
  }

  return monsterGroups;
}

/**
 * Initiate an attack on other monster groups
 * @param {object} db - Firebase database reference
 * @param {string} worldId - World ID
 * @param {object} monsterGroup - The monster group initiating the attack
 * @param {Array} targetGroups - Array of target monster groups
 * @param {object} location - The location coordinates
 * @param {object} ops - Ops instance for batched updates
 * @param {number} now - Current timestamp
 * @returns {object} Action result
 */
export async function initiateAttackOnMonsters(db, worldId, monsterGroup, targetGroups, location, ops, now) {
  const { x, y } = location;

  // Choose a target monster group (typically just the first one)
  const targetCount = Math.min(targetGroups.length, 1);
  const selectedTargets = targetGroups.slice(0, targetCount);

  if (selectedTargets.length === 0) {
    return { action: null, reason: 'no_targets' };
  }

  // Check if target monster group is too powerful compared to the attacking monster group
  const attackerPower = calculateGroupPower(monsterGroup);
  let targetPower = 0;

  for (const target of selectedTargets) {
    targetPower += calculateGroupPower(target);
  }

  const isFeral = monsterGroup.personality?.id === 'FERAL';
  const powerThreshold = isFeral ? 0.01 :
                        (monsterGroup.personality?.id === 'FERAL' ? 0.4 : 0.75);

  if (attackerPower < targetPower * powerThreshold && !isFeral) {
    console.log(`Monster group ${monsterGroup.id} avoiding attack on stronger monster group(s). Power ratio: ${(attackerPower/targetPower).toFixed(2)}`);
    return { action: null, reason: 'target_too_strong' };
  }

  if (isFeral && attackerPower < targetPower * 0.2) {
    console.log(`FERAL monster group ${monsterGroup.id} going berserk! Attacking monster group despite huge power difference! (${attackerPower} vs ${targetPower})`);
  }

  // Create battle ID and prepare battle data
  const battleId = `battle_${now}_${Math.floor(Math.random() * 1000)}`;

  // Create enhanced battle object with full units data for both monster groups
  const battleData = {
    id: battleId,
    locationX: x,
    locationY: y,
    targetTypes: ['monster_group'],
    side1: {
      groups: {
        [monsterGroup.id]: {
          type: 'monster',
          race: monsterGroup.race || 'monster',
          units: monsterGroup.units || {}
        }
      },
      name: `${monsterGroup.name || 'Feral Monsters'}`
    },
    side2: {
      groups: selectedTargets.reduce((obj, group) => {
        obj[group.id] = {
          type: 'monster',
          race: group.race || 'monster',
          units: group.units || {}
        };
        return obj;
      }, {}),
      name: selectedTargets[0].name || 'Monster Group'
    },
    tickCount: 0,
    monsterVsMonster: true
  };

  const chunkKey = monsterGroup.chunkKey;
  const tileKey = `${x},${y}`;

  // Add battle to the tile
  ops.chunk(worldId, chunkKey, `${tileKey}.battles.${battleId}`, battleData);

  // Update attacker monster group to be in battle
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${monsterGroup.id}.battleId`, battleId);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${monsterGroup.id}.battleSide`, 1);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${monsterGroup.id}.battleRole`, 'attacker');
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${monsterGroup.id}.status`, 'fighting');

  // Update defending monster group to be in battle
  for (const target of selectedTargets) {
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${target.id}.battleId`, battleId);
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${target.id}.battleSide`, 2);
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${target.id}.battleRole`, 'defender');
    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${target.id}.status`, 'fighting');

    // Clear movement-related properties if the target was moving
    if (target.status === 'moving') {
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${target.id}.movementPath`, null);
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${target.id}.pathIndex`, null);
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${target.id}.moveStarted`, null);
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${target.id}.moveSpeed`, null);
      ops.chunk(worldId, chunkKey, `${tileKey}.groups.${target.id}.nextMoveTime`, null);

      // Add a special notice about interrupted movement
      ops.chat(worldId, {
        text: `${target.name || 'A monster group'}'s journey has been interrupted by an attack from ${monsterGroup.name || 'another monster group'}!`,
        type: 'event',
        timestamp: now,
        location: { x, y }
      });
    }
  }

  // Add battle start message to chat
  const targetName = selectedTargets[0].name || "Monster group";

  ops.chat(worldId, {
    text: createBattleActionMessage(monsterGroup, 'attack', 'monster', targetName, location),
    type: 'event',
    category: 'monster',
    timestamp: now,
    location: { x, y }
  });

  return {
    action: 'attack',
    targets: selectedTargets.map(t => t.id),
    battleId,
    targetType: 'monster'
  };
}

/**
 * Join an existing battle on this tile
 * @param {object} db - Firebase database reference
 * @param {string} worldId - World ID
 * @param {object} monsterGroup - The monster group joining the battle
 * @param {object} tileData - Data for the current tile
 * @param {object} ops - Ops instance for batched updates
 * @param {number} now - Current timestamp
 * @returns {object} Action result
 */
export async function joinExistingBattle(db, worldId, monsterGroup, tileData, ops, now) {
  const groupId = monsterGroup.id;
  const chunkKey = monsterGroup.chunkKey;
  const tileKey = monsterGroup.tileKey;

  // Get battles on this tile
  const battles = Object.entries(tileData.battles || {})
    .map(([battleId, battle]) => ({ id: battleId, ...battle }));

  if (battles.length === 0) return { action: null };

  // Choose a random battle to join if multiple
  const battle = battles[Math.floor(Math.random() * battles.length)];

  // Decide which side to join - check for FERAL personality trait
  let joinAttackers = Math.random() < 0.3; // Default 30% chance to join attackers

  // Feral personality (or others with randomBattleSides flag) makes truly random choices
  if (monsterGroup.personality?.randomBattleSides) {
    joinAttackers = Math.random() < 0.5;
  }

  // If this is a monster vs monster battle, FERAL has higher chance to join attackers
  if (battle.monsterVsMonster && monsterGroup.personality?.canAttackMonsters) {
    joinAttackers = Math.random() < 0.7;
  }

  const battleSide = joinAttackers ? 1 : 2;

  // Update monster group to join battle
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.battleId`, battle.id);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.battleSide`, battleSide);
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.battleRole`, 'reinforcement');
  ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.status`, 'fighting');

  // Add monster group to battle's side
  const sideKey = battleSide === 1 ? 'side1' : 'side2';
  ops.chunk(worldId, chunkKey, `${tileKey}.battles.${battle.id}.${sideKey}.groups.${groupId}`, {
    type: 'monster',
    race: monsterGroup.race || 'monster',
    units: monsterGroup.units || {}
  });

  // Add a chat message about monsters joining the fight
  const joiningSide = joinAttackers ? "attackers" : "defenders";
  const location = {
    x: parseInt(tileKey.split(',')[0]),
    y: parseInt(tileKey.split(',')[1])
  };

  ops.chat(worldId, {
    text: createBattleActionMessage(monsterGroup, 'join', joiningSide, '', location),
    type: 'event',
    category: 'monster',
    timestamp: now,
    location
  });

  return {
    action: 'join_battle',
    battleId: battle.id,
    side: battleSide
  };
}
