/**
 * Character identity helpers.
 *
 * A user (`uid`) may control several concurrent characters in a world. Each
 * character is a `life` document; the controllable one the player is currently
 * driving is `player.worlds[world].controlledLifeId`.
 *
 * On the map, a player ENTITY represents one character and is keyed in
 * `tile.players` by its `lifeId` (not the uid). Every entity carries both `id`
 * (= lifeId) and `uid` so that ownership, visibility and combat can aggregate
 * per-user while placement is per-character.
 */

// The map-entity / player-unit id for a life.
export function lifeEntityId(life) {
  return String(life._id ?? life.id);
}

// Build the tile.players entity for a character. Ethnicity/trait are copied onto
// the entity so genetics (sight, carry, combat…) can be applied on the map
// without re-loading the life document.
export function makePlayerEntity({ lifeId, uid, displayName, race, ethnicity = null, trait = null }) {
  return { id: String(lifeId), uid, displayName, race, ethnicity, trait };
}

// All player entities on a tile belonging to a uid → [{ lifeId, entity }].
export function entitiesForUid(tile, uid) {
  const out = [];
  for (const [lifeId, entity] of Object.entries(tile?.players || {})) {
    if (entity && entity.uid === uid) out.push({ lifeId, entity });
  }
  return out;
}

// The entity for a specific character on a tile, or null.
export function entityForLife(tile, lifeId) {
  const e = tile?.players?.[String(lifeId)];
  return e || null;
}

// Is this player unit / entity the given character?
export function isLife(entityOrUnit, lifeId) {
  return entityOrUnit && String(entityOrUnit.id) === String(lifeId);
}

// Does this group contain the given character as a player unit?
export function groupHasLife(group, lifeId) {
  if (!group?.units) return false;
  return Object.values(group.units).some(u => u.type === 'player' && String(u.id) === String(lifeId));
}
