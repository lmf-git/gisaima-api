/**
 * Cosmetics — purely visual, gold-priced unlocks that affect how the player
 * shows on the map and profile (banners, structure skins, temples, etc.).
 * Earned with in-realm gold so this is *not* a P2W mechanic.
 *
 * Purchases are debited from the player's reward sink (the structure they
 * are currently standing on, a group they own there, or their home
 * structure). The cosmetic is then added to the player's `equipped` set
 * on the players document — that record is a profile-only catalogue and
 * carries no gameplay value.
 */
import { Ops } from '../lib/ops.js';
import { charge } from './rewards.js';

export const CATALOG = [
  { key: 'banner_red',     name: 'Crimson Banner',      price: 500,  glyph: 'banner', slot: 'banner' },
  { key: 'banner_sage',    name: 'Sage Banner',         price: 500,  glyph: 'banner', slot: 'banner' },
  { key: 'banner_gold',    name: 'Gilded Banner',       price: 1200, glyph: 'banner', slot: 'banner' },
  { key: 'tower_marble',   name: 'Marble Tower Skin',   price: 2500, glyph: 'tower',  slot: 'tower' },
  { key: 'tower_obsidian', name: 'Obsidian Tower Skin', price: 3000, glyph: 'tower',  slot: 'tower' },
  { key: 'crest_dragon',   name: 'Dragon Crest',        price: 1800, glyph: 'crown',  slot: 'crest' },
  { key: 'crest_wolf',     name: 'Wolf Crest',          price: 800,  glyph: 'shield', slot: 'crest' },
  { key: 'temple_small',   name: 'Small Temple',        price: 1500, glyph: 'star',   slot: 'wonder' },
  { key: 'library',        name: 'Library',             price: 1500, glyph: 'scroll', slot: 'wonder' }
];

export function getCatalog() { return CATALOG; }

export async function listOwned(db, worldId, uid) {
  const r = await db.collection('players').findOne(
    { _id: uid },
    { projection: { [`worlds.${worldId}.cosmetics`]: 1 } }
  );
  return r?.worlds?.[worldId]?.cosmetics || [];
}

export async function purchase(db, worldId, uid, key) {
  const item = CATALOG.find((c) => c.key === key);
  if (!item) throw new Error('unknown cosmetic');

  const player = await db.collection('players').findOne(
    { _id: uid },
    { projection: { [`worlds.${worldId}.cosmetics`]: 1 } }
  );
  const owned = player?.worlds?.[worldId]?.cosmetics || [];
  if (owned.includes(key)) throw new Error('already owned');

  // Charge the cost from the player's reward sink (structure or group).
  const ops = new Ops();
  const charged = await charge(db, ops, worldId, uid, { GOLD: item.price });
  if (!charged.ok) throw new Error(charged.reason);
  await ops.flush(db);

  await db.collection('players').updateOne(
    { _id: uid },
    { $addToSet: { [`worlds.${worldId}.cosmetics`]: key } },
    { upsert: true }
  );
  return { ok: true, owned: [...owned, key], paidAt: charged.sink };
}

export async function equip(db, worldId, uid, slot, key) {
  const item = CATALOG.find((c) => c.key === key);
  if (!item || item.slot !== slot) throw new Error('cosmetic does not fit slot');
  const owned = await listOwned(db, worldId, uid);
  if (!owned.includes(key)) throw new Error('not owned');
  await db.collection('players').updateOne(
    { _id: uid },
    { $set: { [`worlds.${worldId}.equipped.${slot}`]: key } },
    { upsert: true }
  );
  return { ok: true };
}
