import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { ITEMS, getRecipeById } from 'gisaima-shared/definitions/ITEMS.js';
import { BUILDINGS } from 'gisaima-shared/definitions/BUILDINGS.js';
import { geneticMod } from 'gisaima-shared/lives/genetics.js';
import { getLife } from '../../db/lives.js';
import { Ops } from '../../lib/ops.js';
import { canUse } from '../../structures/access.js';
import { grantAchievement } from '../../lib/achievements.js';

// Resolve an inventory item to its canonical ITEMS code, tolerating items that
// carry a code, an item key as id, or only a display name.
function itemCode(item) {
  if (!item) return '';
  if (item.code && ITEMS[item.code]) return item.code;
  if (item.id && ITEMS[item.id]) return item.id;
  if (item.name) {
    const k = Object.keys(ITEMS).find(c => ITEMS[c].name === item.name);
    if (k) return k;
  }
  return (item.code || item.id || item.name || '').toString().toUpperCase().replace(/ /g, '_');
}

export async function startCrafting({ uid, data, db }) {
  const { worldId, x, y, recipeId } = data;
  if (!worldId || x === undefined || y === undefined || !recipeId) {
    throw err(400, 'Missing required parameters');
  }

  // Recipes are defined once in shared ITEMS.js (item.recipe) and surfaced via
  // getRecipeById — the same source the crafting UI reads, keyed by item code.
  const recipe = getRecipeById(recipeId);
  if (!recipe) throw err(404, 'Recipe not found');

  const chunkKey = getChunkKey(x, y);
  const tileKey  = `${x},${y}`;

  const chunkDoc  = await db.collection('chunks').findOne({ worldId, chunkKey });
  const structure = chunkDoc?.tiles?.[tileKey]?.structure;
  if (!structure) throw err(404, 'Structure not found');

  const allowed = await canUse({ db, worldId, structure, uid, action: 'recruit' });
  if (!allowed) throw err(403, 'You do not have permission to craft at this structure');

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

  // Tally inventory by item code so material requirements (also codes) match
  // regardless of whether the inventory is array- or object-shaped.
  const inventory = player.inventory || {};
  const invList   = Array.isArray(inventory) ? inventory : Object.values(inventory);
  const haveByCode = {};
  for (const it of invList) {
    const c = itemCode(it);
    if (c) haveByCode[c] = (haveByCode[c] || 0) + (it.quantity || 0);
  }
  for (const [matCode, needed] of Object.entries(recipe.materials)) {
    const have = haveByCode[matCode] || 0;
    if (have < needed) throw err(409, `Not enough ${ITEMS[matCode]?.name || matCode}. Need ${needed}, have ${have}.`);
  }

  let modifier = 1.0 - Math.min(0.5, (craftingLevel - 1) * 0.05);
  // Apply the required building's defined craftingSpeed bonus (cumulative for its
  // level) — sourced from the BUILDINGS definition, since stored building objects
  // don't carry a per-level benefits array.
  if (recipe.requiredBuilding && structure.buildings) {
    for (const b of Object.values(structure.buildings)) {
      if (b.type === recipe.requiredBuilding.type) {
        modifier -= BUILDINGS.getBonusValue(b.type, b.level || 1, 'craftingSpeed');
      }
    }
  }
  // Asari/+craft ethnicity (and craft traits) of the controlling character speed
  // the work by 5% each.
  if (player.controlledLifeId) {
    const life = await getLife(db, worldId, uid, player.controlledLifeId).catch(() => null);
    if (life) modifier -= 0.05 * geneticMod(life, 'craft');
  }
  modifier = Math.max(0.1, modifier);
  const finalTicks = Math.max(1, Math.ceil((recipe.ticksRequired || 1) * modifier));

  const now        = Date.now();
  const craftingId = `crafting_${worldId}_${uid}_${now}`;

  // Spend materials from inventory, matching by code and preserving shape.
  const matsCopy = { ...recipe.materials };
  let updatedInv;
  if (Array.isArray(inventory)) {
    updatedInv = [];
    for (const item of inventory) {
      const c    = itemCode(item);
      const need = matsCopy[c] || 0;
      if (need > 0) {
        const use = Math.min(need, item.quantity || 0);
        matsCopy[c] -= use;
        if ((item.quantity || 0) > use) updatedInv.push({ ...item, quantity: item.quantity - use });
      } else { updatedInv.push(item); }
    }
  } else {
    updatedInv = { ...inventory };
    for (const matCode of Object.keys(matsCopy)) {
      for (const [iid, item] of Object.entries(updatedInv)) {
        if (matsCopy[matCode] <= 0) break;
        if (itemCode(item) !== matCode) continue;
        const use = Math.min(matsCopy[matCode], item.quantity || 0);
        matsCopy[matCode] -= use;
        if ((item.quantity || 0) - use <= 0) delete updatedInv[iid];
        else updatedInv[iid] = { ...item, quantity: item.quantity - use };
      }
    }
  }

  const craftingData = {
    id: craftingId, recipeId, playerId: uid, playerName: player.displayName,
    worldId, structureId: structure.id, structureLocation: { x, y },
    startedAt: now, ticksRequired: finalTicks, ticksCompleted: 0,
    materials: recipe.materials,
    result: {
      code: recipe.result.id,
      name: recipe.result.name,
      type: recipe.result.type,
      quantity: recipe.result.quantity || 1,
      rarity: recipe.result.rarity || 'common',
      description: recipe.result.description
    },
    status: 'in_progress', processed: false
  };

  const ops = new Ops();
  ops.world(worldId, `crafting.${craftingId}`, craftingData);
  ops.player(uid, worldId, 'inventory',                updatedInv);
  ops.player(uid, worldId, 'crafting.current',         craftingId);
  ops.player(uid, worldId, 'crafting.ticksRequired',   finalTicks);
  ops.chat(worldId, {
    location: { x, y },
    text: `${player.displayName} started crafting ${recipe.result.name}.`,
    timestamp: now, type: 'event', category: 'player', userId: uid
  });

  await ops.flush(db);

  await grantAchievement(db, uid, worldId, 'first_craft');

  return { success: true, craftingId, ticksRequired: finalTicks, result: craftingData.result };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export default startCrafting;
