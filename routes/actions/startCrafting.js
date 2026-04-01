import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { applyUpdates } from '../../db/adapter.js';

export async function startCrafting({ uid, data, db }) {
  const { worldId, x, y, recipeId } = data;
  if (!worldId || x === undefined || y === undefined || !recipeId) {
    throw err(400, 'Missing required parameters');
  }

  const recipe = RECIPES.find(r => r.id === recipeId);
  if (!recipe) throw err(404, 'Recipe not found');

  const chunkKey = getChunkKey(x, y);
  const tileKey  = `${x},${y}`;

  const chunkDoc  = await db.collection('chunks').findOne({ worldId, chunkKey });
  const structure = chunkDoc?.tiles?.[tileKey]?.structure;
  if (!structure) throw err(404, 'Structure not found');

  const playerDoc = await db.collection('players').findOne({ _id: uid });
  if (!playerDoc?.worlds?.[worldId]) throw err(404, 'Player data not found');
  const player        = playerDoc.worlds[worldId];
  const craftingLevel = player.skills?.crafting?.level || 1;

  if (recipe.requiredLevel && recipe.requiredLevel > craftingLevel) {
    throw err(409, `This recipe requires crafting level ${recipe.requiredLevel}`);
  }

  if (recipe.requiredBuilding) {
    const { type, level } = recipe.requiredBuilding;
    const hasBuilding = Object.values(structure.buildings || {})
      .some(b => b.type === type && (b.level || 1) >= level);
    if (!hasBuilding) throw err(409, `This recipe requires a ${type} of level ${level} or higher`);
  }

  const inventory = player.inventory || {};
  for (const [matName, needed] of Object.entries(recipe.materials)) {
    const have = Array.isArray(inventory)
      ? inventory.filter(i => i.name === matName).reduce((s, i) => s + (i.quantity || 0), 0)
      : Object.values(inventory).filter(i => i.name === matName).reduce((s, i) => s + (i.quantity || 0), 0);
    if (have < needed) throw err(409, `Not enough ${matName}. Need ${needed}, have ${have}.`);
  }

  let modifier = 1.0 - Math.min(0.5, (craftingLevel - 1) * 0.05);
  if (recipe.requiredBuilding && structure.buildings) {
    for (const b of Object.values(structure.buildings)) {
      if (b.type === recipe.requiredBuilding.type) {
        for (const ben of (b.benefits || [])) {
          if (ben.bonus?.craftingSpeed) modifier -= ben.bonus.craftingSpeed;
        }
      }
    }
  }
  modifier = Math.max(0.1, modifier);
  const finalTicks = Math.ceil((recipe.craftingTime || 1) * modifier);

  const now        = Date.now();
  const craftingId = `crafting_${worldId}_${uid}_${now}`;

  const matsCopy = { ...recipe.materials };
  let updatedInv;
  if (Array.isArray(inventory)) {
    updatedInv = [];
    for (const item of inventory) {
      const need = matsCopy[item.name] || 0;
      if (need > 0) {
        const use = Math.min(need, item.quantity);
        matsCopy[item.name] -= use;
        if (item.quantity > use) updatedInv.push({ ...item, quantity: item.quantity - use });
      } else { updatedInv.push(item); }
    }
  } else {
    updatedInv = { ...inventory };
    for (const [matName, need] of Object.entries(matsCopy)) {
      for (const [iid, item] of Object.entries(updatedInv)) {
        if (item.name !== matName) continue;
        const use = Math.min(need, item.quantity || 0);
        matsCopy[matName] -= use;
        if (item.quantity - use <= 0) delete updatedInv[iid];
        else updatedInv[iid] = { ...item, quantity: item.quantity - use };
        if (matsCopy[matName] <= 0) break;
      }
    }
  }

  const craftingData = {
    id: craftingId, recipeId, playerId: uid, playerName: player.displayName,
    worldId, structureId: structure.id, structureLocation: { x, y },
    startedAt: now, ticksRequired: finalTicks, ticksCompleted: 0,
    materials: recipe.materials,
    result: { name: recipe.result.name, type: recipe.result.type, quantity: recipe.result.quantity || 1, rarity: recipe.result.rarity || 'common', description: recipe.result.description },
    status: 'in_progress', processed: false
  };

  const updates = {
    [`worlds/${worldId}/crafting/${craftingId}`]:             craftingData,
    [`players/${uid}/worlds/${worldId}/inventory`]:           updatedInv,
    [`players/${uid}/worlds/${worldId}/crafting/current`]:    craftingId,
    [`players/${uid}/worlds/${worldId}/crafting/ticksRequired`]: finalTicks,
    [`worlds/${worldId}/chat/crafting_${craftingId}`]: {
      location: { x, y },
      text: `${player.displayName} started crafting ${recipe.result.name}.`,
      timestamp: now, type: 'event'
    }
  };

  await applyUpdates(db, updates);
  return { success: true, craftingId, ticksRequired: finalTicks, result: craftingData.result };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

const RECIPES = [
  { id: 'wooden_sword', name: 'Wooden Sword', category: 'weapon', materials: { 'Wooden Sticks': 5 }, result: { name: 'Wooden Sword', type: 'weapon', rarity: 'common', quantity: 1, description: 'A basic wooden sword.' }, craftingTime: 1, requiredLevel: 1 },
  { id: 'stone_sword',  name: 'Stone Sword',  category: 'weapon', materials: { 'Wooden Sticks': 2, 'Stone Pieces': 5 }, result: { name: 'Stone Sword', type: 'weapon', rarity: 'common', quantity: 1, description: 'A stone-bladed sword.' }, craftingTime: 2, requiredLevel: 2 },
  { id: 'iron_sword',   name: 'Iron Sword',   category: 'weapon', materials: { 'Wooden Sticks': 2, 'Iron Ingot': 3 }, result: { name: 'Iron Sword', type: 'weapon', rarity: 'uncommon', quantity: 1, description: 'A well-crafted iron sword.' }, craftingTime: 3, requiredLevel: 3, requiredBuilding: { type: 'smithy', level: 2 } },
  { id: 'herbal_tea',   name: 'Herbal Tea',   category: 'consumable', materials: { 'Medicinal Herb': 2, 'Water Vial': 1 }, result: { name: 'Herbal Tea', type: 'consumable', rarity: 'common', quantity: 2, description: 'A soothing tea.' }, craftingTime: 1, requiredLevel: 1, requiredBuilding: { type: 'farm', level: 1 } },
  { id: 'hearty_stew',  name: 'Hearty Stew',  category: 'consumable', materials: { 'Vegetables': 3, 'Meat': 2, 'Water Vial': 1 }, result: { name: 'Hearty Stew', type: 'consumable', rarity: 'uncommon', quantity: 2, description: 'A filling meal.' }, craftingTime: 2, requiredLevel: 2, requiredBuilding: { type: 'farm', level: 2 } },
  { id: 'minor_mana_potion', name: 'Minor Mana Potion', category: 'consumable', materials: { 'Blue Herb': 3, 'Crystal Water': 1 }, result: { name: 'Minor Mana Potion', type: 'consumable', rarity: 'common', quantity: 2, description: 'Restores mana.' }, craftingTime: 1, requiredLevel: 2, requiredBuilding: { type: 'academy', level: 1 } },
  { id: 'miners_lamp',  name: "Miner's Lamp",  category: 'tool', materials: { 'Iron Ingot': 1, 'Oil': 2, 'Glass': 1 }, result: { name: "Miner's Lamp", type: 'tool', rarity: 'common', quantity: 1, description: 'Improves mining.' }, craftingTime: 2, requiredLevel: 2, requiredBuilding: { type: 'mine', level: 1 } },
  { id: 'trading_contract', name: 'Trading Contract', category: 'document', materials: { 'Parchment': 2, 'Ink': 1 }, result: { name: 'Trading Contract', type: 'document', rarity: 'common', quantity: 3, description: 'A basic trade document.' }, craftingTime: 1, requiredLevel: 1, requiredBuilding: { type: 'market', level: 1 } }
];

export default startCrafting;
