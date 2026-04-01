/**
 * Gathering tick processing for Gisaima
 */

import { merge } from 'gisaima-shared/economy/items.js';
import { getBiomeItems, ITEMS } from 'gisaima-shared/definitions/ITEMS.js';

export function processGathering(worldId, updates, group, chunkKey, tileKey, groupId, tile, now, terrainGenerator = null) {
  if (group.status === 'cancellingGather') return false;
  if (group.status !== 'gathering')        return false;

  const groupPath = `worlds/${worldId}/chunks/${chunkKey}/${tileKey}/groups/${groupId}`;

  if (group.gatheringTicksRemaining === undefined) {
    console.warn(`Invalid gathering state for group ${groupId}`);
    updates[`${groupPath}/status`]                  = 'idle';
    updates[`${groupPath}/gatheringBiome`]           = null;
    updates[`${groupPath}/gatheringTicksRemaining`]  = null;
    return false;
  }

  if (group.gatheringTicksRemaining > 1) {
    updates[`${groupPath}/gatheringTicksRemaining`] = group.gatheringTicksRemaining - 1;
    return false;
  }

  const [x, y] = tileKey.split(',').map(Number);
  let biome    = group.gatheringBiome || tile.biome?.name || 'plains';
  let rarity   = 'common';
  let terrainData = null;

  try {
    if (terrainGenerator) {
      terrainData = terrainGenerator.getTerrainData(x, y);
      biome       = terrainData.biome.name;
      rarity      = terrainData.rarity || 'common';
    }
  } catch (err) {
    console.warn(`TerrainGenerator error for group ${groupId}: ${err.message}`);
  }

  const gatheredItems = generateGatheredItems(group, biome, rarity, terrainData);

  updates[`${groupPath}/items`]                  = group.items ? merge(group.items, gatheredItems) : gatheredItems;
  updates[`${groupPath}/status`]                 = 'idle';
  updates[`${groupPath}/gatheringBiome`]         = null;
  updates[`${groupPath}/gatheringTicksRemaining`] = null;

  const itemsList = Object.entries(gatheredItems).map(([code, qty]) => {
    const def = ITEMS[code];
    return def ? `${qty} ${def.name}${def.rarity && def.rarity !== 'common' ? ` (${def.rarity})` : ''}` : `${qty} ${code}`;
  });

  const chatId = `gather_${now}_${groupId}`;
  updates[`worlds/${worldId}/chat/${chatId}`] = {
    text: `${group.name || 'Unnamed group'} gathered resources in ${biome} biome at (${tileKey.replace(',', ', ')})${itemsList.length ? ': ' + itemsList.join(', ') : ''}`,
    type: 'event',
    timestamp: now,
    location: { x, y }
  };

  // Special announcement for rare+ items
  const specialItems = Object.entries(gatheredItems)
    .filter(([code]) => ['rare','epic','legendary','mythic'].includes(ITEMS[code]?.rarity?.toLowerCase()))
    .map(([code]) => ({ code, name: ITEMS[code].name, rarity: ITEMS[code].rarity }));

  if (specialItems.length > 0) {
    const stars = { rare: '★★★', epic: '★★★★', legendary: '★★★★★', mythic: '✦✦✦✦✦' };
    const rareChatId = `rare_${now}_${groupId}`;
    updates[`worlds/${worldId}/chat/${rareChatId}`] = {
      text: `${group.name || 'Unnamed group'} has discovered something extraordinary!\n${specialItems.map(i => `${stars[i.rarity.toLowerCase()] || '★★★'} ${i.name} ${stars[i.rarity.toLowerCase()] || '★★★'}`).join('\n')}`,
      type: 'event',
      timestamp: now + 1,
      location: { x, y }
    };
  }

  return true;
}

function generateGatheredItems(group, biome = 'plains', terrainRarity = 'common', terrainData = null) {
  const items          = {};
  const numGatherers   = group.units ? (Array.isArray(group.units) ? group.units.length : Object.keys(group.units).length) : 1;
  const baseItems      = Math.floor(Math.random() * 2) + Math.ceil(numGatherers / 2);
  const rarityMult     = { common: 1, uncommon: 1.25, rare: 1.5, epic: 1.75, legendary: 2, mythic: 2.5 };
  const multiplier     = rarityMult[terrainRarity] || 1;

  function addItem(code, qty) {
    if (!code) return;
    const c = code.toUpperCase();
    items[c] = (items[c] || 0) + Math.ceil(qty * multiplier);
  }

  addItem('WOODEN_STICKS', Math.floor(Math.random() * 5) + 1);
  addItem('STONE_PIECES',  Math.floor(Math.random() * 3) + 1);

  const biomeItems = getBiomeItems(biome);
  const itemCount  = Math.ceil(baseItems * multiplier);
  for (let i = 0; i < itemCount && biomeItems.length > 0; i++) {
    const bi = biomeItems[Math.floor(Math.random() * biomeItems.length)];
    if (bi?.id) addItem(bi.id, bi.quantity || 1);
  }

  if (terrainData) {
    if (terrainData.lavaValue  > 0.3) addItem('VOLCANIC_GLASS',  Math.ceil(Math.random() * 2));
    if (terrainData.riverValue > 0.2 || terrainData.lakeValue > 0.2) addItem('FRESH_WATER', Math.ceil(Math.random() * 3));
    if (terrainData.height     > 0.8) addItem('MOUNTAIN_CRYSTAL', 1);
  }

  const bonusChance = { common: 0.05, uncommon: 0.15, rare: 0.35, epic: 0.6, legendary: 0.85, mythic: 1.0 };
  const bonusCount  = { rare: 1, epic: 1, legendary: 2, mythic: 3 };
  if (Math.random() < (bonusChance[terrainRarity] || 0)) {
    const specials = getSpecialItemsByBiome(biome, terrainRarity);
    for (let i = 0; i < (bonusCount[terrainRarity] || 0) && i < specials.length; i++) {
      if (specials[i]?.id) addItem(specials[i].id, specials[i].quantity || 1);
    }
  }

  return items;
}

function getSpecialItemsByBiome(biome, rarity) {
  const result   = [];
  const bl       = biome.toLowerCase();

  if (bl.includes('forest') || bl.includes('woods') || bl.includes('grove'))
    result.push({ id: 'MEDICINAL_HERBS', quantity: Math.floor(Math.random() * 2) + 1 });
  else if (bl.includes('mountain') || bl.includes('peak') || bl.includes('hill')) {
    result.push({ id: 'MOUNTAIN_CRYSTAL', quantity: 1 });
    if (Math.random() < 0.4) result.push({ id: 'IRON_ORE', quantity: Math.floor(Math.random() * 2) + 1 });
  } else if (bl.includes('desert') || bl.includes('sand') || bl.includes('dune')) {
    result.push({ id: 'SAND_CRYSTAL', quantity: 1 });
    if (Math.random() < 0.3) result.push({ id: 'CACTUS_FRUIT', quantity: Math.floor(Math.random() * 3) + 1 });
  } else if (bl.includes('lava') || bl.includes('volcanic') || bl.includes('magma'))
    result.push({ id: 'VOLCANIC_GLASS', quantity: Math.floor(Math.random() * 2) + 1 });
  else if (bl.includes('lake') || bl.includes('river') || bl.includes('ocean') || bl.includes('water')) {
    result.push({ id: 'FRESH_WATER', quantity: Math.floor(Math.random() * 3) + 2 });
    if (Math.random() < 0.4) result.push({ id: 'FISH', quantity: Math.floor(Math.random() * 2) + 1 });
  } else if (bl.includes('swamp') || bl.includes('marsh') || bl.includes('bog'))
    result.push({ id: 'MEDICINAL_HERBS', quantity: Math.floor(Math.random() * 2) + 1 });
  else if (bl.includes('plains') || bl.includes('grassland') || bl.includes('meadow'))
    result.push({ id: 'WHEAT', quantity: Math.floor(Math.random() * 3) + 2 });

  if (['epic','legendary','mythic'].includes(rarity) || Math.random() < 0.1)
    result.push({ id: 'MYSTERIOUS_ARTIFACT', quantity: 1 });

  return result;
}
