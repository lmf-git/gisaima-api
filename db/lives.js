/**
 * Lives — character deaths, revivals, heirs. A user has one active character
 * per world but a chronicle of past lives.
 *
 * Schema (`lives`):
 *   _id, worldId, uid, name, born (Date), died?, cause?, by?, deeds, parentLifeId?
 *
 * On death an entry is created and the player record's `alive` is set false.
 * Respawn creates a new life and clears `inGroup`; assets remain at the player
 * spawn store (capacity 200) — anything beyond that is dropped at the death
 * location for others to scavenge.
 */
import { ObjectId } from 'mongodb';
import { getChunkKey } from 'gisaima-shared/map/cartography.js';

const SPAWN_STORE_CAP = 200;

// The realm's current age, measured in game ticks. Lives are stamped with the
// tick they were born/died on so the lineage can be told in in-world time (Ages
// and years) rather than real-world dates. Falls back to 0 for a fresh world.
export async function worldTick(db, worldId) {
  const w = await db.collection('worlds').findOne(
    { _id: worldId },
    { projection: { 'info.tickCount': 1 } }
  );
  return Number(w?.info?.tickCount) || 0;
}

// Place a character entity directly on a tile (used when a child is born onto
// the map). Entities are keyed by lifeId and carry uid.
async function _placeOnMap(db, worldId, uid, lifeId, name, race, location) {
  const chunkKey = getChunkKey(location.x, location.y);
  const tileKey  = `${location.x},${location.y}`;
  await db.collection('chunks').updateOne(
    { worldId, chunkKey },
    { $set: { [`tiles.${tileKey}.players.${String(lifeId)}`]: { id: String(lifeId), uid, displayName: name, race: race || 'human' } } },
    { upsert: true }
  );
}

export async function listFor(db, worldId, uid) {
  return db.collection('lives')
    .find({ worldId, uid })
    .sort({ born: -1 })
    .toArray();
}

export async function currentLife(db, worldId, uid) {
  return db.collection('lives').findOne({ worldId, uid, died: null });
}

export async function birth(db, { worldId, uid, name, race = 'human', sex = null, ethnicity = null, trait = null, parentLifeId = null, makeControlled = true }) {
  const insert = {
    worldId, uid, name, race,
    // Founding characters get a chosen sex and a randomly-assigned ethnicity &
    // trait so the genetics layer (sight/carry/combat) applies to them too, and
    // so they can pass heritage to heirs.
    sex: sex === 'm' || sex === 'f' ? sex : SEX_OPTIONS[Math.floor(Math.random() * SEX_OPTIONS.length)],
    ethnicity: ethnicity || _randomEthnicity(),
    trait: trait || _randomTrait(),
    born: new Date(),
    bornTick: await worldTick(db, worldId),
    died: null,
    deeds: 0,
    // Per-life gameplay state — each character now carries its own placement so
    // a single user can control several lives concurrently.
    active: true,
    alive: false,            // becomes true once spawned onto the map
    lastLocation: null,
    inGroup: null,
    spouseLifeId: null,      // set by the marry action
    parentLifeId: parentLifeId ? new ObjectId(parentLifeId) : null
  };
  const r = await db.collection('lives').insertOne(insert);
  const set = {
    [`worlds.${worldId}.displayName`]: name,
    [`worlds.${worldId}.currentLifeId`]: r.insertedId
  };
  if (makeControlled) set[`worlds.${worldId}.controlledLifeId`] = r.insertedId;
  await db.collection('players').updateOne({ _id: uid }, { $set: set }, { upsert: true });
  return { ...insert, _id: r.insertedId };
}

// All living, controllable characters a user has in a world.
export async function listActive(db, worldId, uid) {
  return db.collection('lives')
    .find({ worldId, uid, active: true, died: null })
    .sort({ born: 1 })
    .toArray();
}

// Switch which character the player is driving. Validates ownership + that the
// target life is active and alive.
export async function setControlled(db, worldId, uid, lifeId) {
  const _id = new ObjectId(lifeId);
  const life = await db.collection('lives').findOne({ _id, worldId, uid });
  if (!life)        throw new Error('character not found');
  if (life.died)    throw new Error('that character has died');
  if (!life.active) throw new Error('that character is not active');
  if (!life.alive)  throw new Error('that character is not yet on the map');
  await db.collection('players').updateOne(
    { _id: uid },
    { $set: { [`worlds.${worldId}.controlledLifeId`]: _id, [`worlds.${worldId}.displayName`]: life.name } }
  );
  return life;
}

// Ensure a legacy player (joined before the lives binding existed) has at least
// one bound, active life and a controlledLifeId. Idempotent.
export async function ensureBoundLife(db, worldId, uid, { name, race = 'human', sex = null } = {}) {
  const existing = await db.collection('lives').findOne({ worldId, uid, active: true, died: null });
  if (existing) return existing;
  return birth(db, { worldId, uid, name: name || `Wanderer ${String(uid).slice(0, 4)}`, race, sex, makeControlled: true });
}

export async function addDeath(db, worldId, uid, { cause = 'unknown', by = null, at = new Date(), inventory = null, location = null } = {}) {
  const life = await currentLife(db, worldId, uid);
  if (life) {
    await db.collection('lives').updateOne(
      { _id: life._id },
      { $set: { died: at, diedTick: await worldTick(db, worldId), cause, by, deathLocation: location } }
    );
  }
  await db.collection('players').updateOne(
    { _id: uid },
    {
      $set: { [`worlds.${worldId}.alive`]: false },
      $inc: { [`worlds.${worldId}.deaths`]: 1 }
    },
    { upsert: true }
  );

  // Handle assets: anything beyond spawn-store cap is dropped at location.
  if (inventory && location) {
    const stored = {};
    const dropped = {};
    let used = 0;
    for (const [k, q] of Object.entries(inventory)) {
      const fit = Math.min(q, Math.max(0, SPAWN_STORE_CAP - used));
      if (fit > 0) {
        stored[k] = fit;
        used += fit;
      }
      if (q - fit > 0) dropped[k] = q - fit;
    }
    if (Object.keys(stored).length) {
      await db.collection('players').updateOne(
        { _id: uid },
        { $set: { [`worlds.${worldId}.spawnStore`]: stored } }
      );
    }
    if (Object.keys(dropped).length) {
      await db.collection('item_drops').insertOne({
        worldId,
        x: location.x, y: location.y,
        items: dropped,
        droppedAt: at,
        from: uid
      });
    }
  }

  return { ok: true };
}

/**
 * Respawn into either:
 *  - a named fresh life (caller passes `name`)
 *  - a specific previously-created heir (`heirLifeId`) — the heir is promoted
 *    to the active life. The heir's ethnicity, sex, and trait carry forward.
 *
 * In both cases the player is marked alive, placed at `spawnPoint`, and any
 * `inGroup` reference is cleared. The previous active life (if any) stays in
 * the chronicle as a closed entry.
 */
export async function respawn(db, worldId, uid, name, spawnPoint, heirLifeId = null) {
  await db.collection('players').updateOne(
    { _id: uid },
    {
      $set: {
        [`worlds.${worldId}.alive`]: true,
        [`worlds.${worldId}.lastLocation`]: spawnPoint || { x: 0, y: 0 },
        [`worlds.${worldId}.inGroup`]: null
      }
    },
    { upsert: true }
  );

  if (heirLifeId) {
    const _id = new ObjectId(heirLifeId);
    const heir = await db.collection('lives').findOne({ _id, worldId, uid });
    if (!heir) throw new Error('heir not found');
    if (heir.died) throw new Error('that life has already ended');
    if (!heir.isHeir) throw new Error('that life is not an heir');

    // Promote heir to the active life — clear isHeir, set as current.
    await db.collection('lives').updateOne(
      { _id },
      { $set: { isHeir: false, activatedAt: new Date() } }
    );
    await db.collection('players').updateOne(
      { _id: uid },
      {
        $set: {
          [`worlds.${worldId}.displayName`]: heir.name,
          [`worlds.${worldId}.currentLifeId`]: heir._id,
          [`worlds.${worldId}.ethnicity`]: heir.ethnicity || null
        }
      }
    );
    return heir;
  }

  return birth(db, { worldId, uid, name: name || `Heir of ${uid.slice(0, 6)}` });
}

// Patch arbitrary per-character gameplay fields (inGroup, lastLocation, alive…).
export async function patchLife(db, lifeId, fields) {
  await db.collection('lives').updateOne({ _id: new ObjectId(lifeId) }, { $set: fields });
}

export async function getLife(db, worldId, uid, lifeId) {
  return db.collection('lives').findOne({ _id: new ObjectId(lifeId), worldId, uid });
}

// Mark a character as placed on the map at `location`. Mirrors the controlled
// character's state onto the player doc so existing reads keep working.
export async function markSpawned(db, worldId, uid, lifeId, location, { makeControlled = true } = {}) {
  const _id = new ObjectId(lifeId);
  await db.collection('lives').updateOne(
    { _id, worldId, uid },
    { $set: { alive: true, active: true, lastLocation: location, inGroup: null } }
  );
  const life = await db.collection('lives').findOne({ _id });
  const set = {
    [`worlds.${worldId}.alive`]: true,
    [`worlds.${worldId}.lastLocation`]: location
  };
  if (makeControlled) {
    set[`worlds.${worldId}.controlledLifeId`] = _id;
    set[`worlds.${worldId}.displayName`] = life?.name;
  }
  await db.collection('players').updateOne({ _id: uid }, { $set: set }, { upsert: true });
  return life;
}

/**
 * Kill a specific character. Marks that life dead, and on the player doc:
 * decrements nothing but increments deaths, recomputes `alive` (true while ANY
 * character still lives), and — if the dead one was being controlled — hands
 * control to another living character. Assets handled as in addDeath.
 */
export async function killCharacter(db, worldId, uid, lifeId, { cause = 'unknown', by = null, at = new Date(), location = null, inventory = null } = {}) {
  const _id = new ObjectId(lifeId);
  await db.collection('lives').updateOne(
    { _id, worldId, uid },
    { $set: { died: at, diedTick: await worldTick(db, worldId), cause, by, deathLocation: location, active: false, alive: false, inGroup: null } }
  );

  const remaining = await db.collection('lives')
    .find({ worldId, uid, active: true, died: null, alive: true })
    .sort({ born: 1 })
    .toArray();
  const anyAlive = remaining.length > 0;

  const player = await db.collection('players').findOne(
    { _id: uid }, { projection: { [`worlds.${worldId}.controlledLifeId`]: 1 } }
  );
  const controlled = player?.worlds?.[worldId]?.controlledLifeId;

  const set = { [`worlds.${worldId}.alive`]: anyAlive };
  if (String(controlled) === String(_id)) {
    set[`worlds.${worldId}.controlledLifeId`] = anyAlive ? remaining[0]._id : null;
    if (anyAlive) set[`worlds.${worldId}.displayName`] = remaining[0].name;
  }
  await db.collection('players').updateOne(
    { _id: uid },
    { $set: set, $inc: { [`worlds.${worldId}.deaths`]: 1 } },
    { upsert: true }
  );

  if (inventory && location) {
    const stored = {};
    const dropped = {};
    let used = 0;
    for (const [k, q] of Object.entries(inventory)) {
      const fit = Math.min(q, Math.max(0, SPAWN_STORE_CAP - used));
      if (fit > 0) { stored[k] = fit; used += fit; }
      if (q - fit > 0) dropped[k] = q - fit;
    }
    if (Object.keys(stored).length) {
      await db.collection('players').updateOne({ _id: uid }, { $set: { [`worlds.${worldId}.spawnStore`]: stored } });
    }
    if (Object.keys(dropped).length) {
      await db.collection('item_drops').insertOne({ worldId, x: location.x, y: location.y, items: dropped, droppedAt: at, from: uid });
    }
  }

  return { ok: true, anyAlive };
}

export async function deathFeed(db, worldId, limit = 50) {
  return db.collection('lives')
    .find({ worldId, died: { $ne: null } })
    .sort({ died: -1 })
    .limit(limit)
    .toArray();
}

// ── Reproduction / heirs ──────────────────────────────────────────────────
// Lives may produce heirs. Each heir is itself a Life document with a
// `parents: [lifeIdA, lifeIdB?]` field. Ethnicity, sex and traits are derived
// from the parent(s) using a deterministic formula seeded by parent ids +
// world tick — twins/triplets are possible (probabilities below).
//
// Currently no UI ties a Life to a real player slot; heirs surface in
// `/characters` and are eligible for `respawn(lifeId)` when the player's
// active life ends. This is the foundation; player switching between active
// heirs lands as a UI affordance next pass.

const SEX_OPTIONS = ['m', 'f'];
const TWIN_PROBABILITY     = 0.03;
const TRIPLET_PROBABILITY  = 0.005;

// Built-in ethnicity catalogue — a deliberately small fictional set that
// fits the parchment / cartographic setting. Each carries a small bonus
// hint surfaced on the profile / heir card.
export const ETHNICITIES = [
  { key: 'Westmark', bonus: '+1 carry', tag: 'Mercantile coastfolk' },
  { key: 'Norvel',   bonus: '+1 sight', tag: 'Snowmark mountainfolk' },
  { key: 'Sylvan',   bonus: '+1 yield', tag: 'Forest-born' },
  { key: 'Drava',    bonus: '+1 atk',   tag: 'Highland clans' },
  { key: 'Asari',    bonus: '+1 craft', tag: 'River caravaneers' },
  { key: 'Brennec',  bonus: '+1 def',   tag: 'Highland founders' }
];

function _hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

const TRAIT_POOL = ['steadfast', 'quick', 'cautious', 'cunning', 'kind', 'wrathful'];
function _randomEthnicity() { return ETHNICITIES[Math.floor(Math.random() * ETHNICITIES.length)].key; }
function _randomTrait()     { return TRAIT_POOL[Math.floor(Math.random() * TRAIT_POOL.length)]; }

function _pickEthnicity(parents) {
  if (!parents?.length) return ETHNICITIES[0].key;
  // Blend rule: child gets one parent's ethnicity unless both share it.
  if (parents.length === 1) return parents[0].ethnicity || ETHNICITIES[0].key;
  if (parents[0].ethnicity === parents[1].ethnicity) return parents[0].ethnicity;
  const seed = _hash(`${parents[0]._id || ''}${parents[1]._id || ''}`);
  return parents[seed & 1].ethnicity || parents[0].ethnicity || ETHNICITIES[0].key;
}

function _pickTrait(parents) {
  const pool = [];
  for (const p of parents) if (p?.trait) pool.push(p.trait);
  pool.push('steadfast', 'quick', 'cautious', 'cunning', 'kind', 'wrathful');
  const seed = _hash(`${parents.map((p) => p?._id || '').join('|')}trait`);
  return pool[seed % pool.length];
}

function _howManyChildren() {
  const r = Math.random();
  if (r < TRIPLET_PROBABILITY) return 3;
  if (r < TRIPLET_PROBABILITY + TWIN_PROBABILITY) return 2;
  return 1;
}

// Same-tile check used for marriage and reproduction. Two characters "together"
// — whether mobilised in one group or demobilised at the same structure — share
// a tile, so co-location reduces to equal lastLocation.
function _sameTile(a, b) {
  return a?.lastLocation && b?.lastLocation &&
    a.lastLocation.x === b.lastLocation.x &&
    a.lastLocation.y === b.lastLocation.y;
}

/**
 * Marry two living characters who are together on the same tile. Sets a mutual
 * `spouseLifeId`. The caller must own at least one of the two. Returns the
 * location and (if any) the structure where the wedding takes place so the
 * route can announce a wedding event.
 */
export async function marry(db, worldId, callerUid, lifeIdA, lifeIdB) {
  if (!lifeIdA || !lifeIdB || String(lifeIdA) === String(lifeIdB)) {
    throw new Error('two different characters are required');
  }
  const a = await db.collection('lives').findOne({ _id: new ObjectId(lifeIdA), worldId });
  const b = await db.collection('lives').findOne({ _id: new ObjectId(lifeIdB), worldId });
  if (!a || !b) throw new Error('character not found');
  if (a.died || b.died) throw new Error('a character has died');
  if (!a.alive || !b.alive) throw new Error('both characters must be on the map');
  if (callerUid !== a.uid && callerUid !== b.uid) throw new Error('you must own one of the characters');
  if (a.spouseLifeId || b.spouseLifeId) throw new Error('a character is already married');
  if (!_sameTile(a, b)) throw new Error('the couple must be together on the same tile');

  await db.collection('lives').updateOne({ _id: a._id }, { $set: { spouseLifeId: b._id, marriedAt: new Date() } });
  await db.collection('lives').updateOne({ _id: b._id }, { $set: { spouseLifeId: a._id, marriedAt: new Date() } });

  const { x, y } = a.lastLocation;
  const chunkKey = getChunkKey(x, y);
  const chunkDoc = await db.collection('chunks').findOne(
    { worldId, chunkKey }, { projection: { [`tiles.${x},${y}.structure.name`]: 1, [`tiles.${x},${y}.structure.type`]: 1 } }
  );
  const structure = chunkDoc?.tiles?.[`${x},${y}`]?.structure || null;
  return { ok: true, location: { x, y }, structureName: structure?.name || null, names: [a.name, b.name] };
}

export async function reproduce(db, worldId, parentLifeIds = []) {
  if (!parentLifeIds.length) throw new Error('at least one parent required');
  const _ids = parentLifeIds.map((id) => new ObjectId(id));
  const parents = await db.collection('lives').find({ _id: { $in: _ids } }).toArray();
  if (!parents.length) throw new Error('parents not found');

  // Reproduction with two parents requires them to be married to each other and
  // together on the same tile (in one group or demobilised at one structure).
  if (parents.length >= 2) {
    const [p0, p1] = parents;
    const married = String(p0.spouseLifeId || '') === String(p1._id) &&
                    String(p1.spouseLifeId || '') === String(p0._id);
    if (!married) throw new Error('parents must be married to each other');
    if (!_sameTile(p0, p1)) throw new Error('parents must be together on the same tile');
  }

  const ethnicity = _pickEthnicity(parents);
  const trait     = _pickTrait(parents);
  const bornTick  = await worldTick(db, worldId);

  const count = _howManyChildren();
  const heirs = [];
  for (let i = 0; i < count; i++) {
    // Each child independently goes to one of the (up to two) parents 50:50.
    const ownerUid = parents.length > 1
      ? (Math.random() < 0.5 ? parents[0].uid : parents[1].uid)
      : parents[0].uid;
    const sex = SEX_OPTIONS[Math.floor(Math.random() * SEX_OPTIONS.length)];
    const baseName = parents[0].name?.split(' ')?.[0] || 'Heir';
    const insert = {
      worldId,
      uid: ownerUid,
      name: `${baseName} the ${trait}${count > 1 ? ` (${i + 1})` : ''}`,
      born: new Date(),
      bornTick,
      died: null,
      deeds: 0,
      sex,
      ethnicity,
      trait,
      // A child is a real, controllable character. If the owning parent is on
      // the map, the child is born there (alive + switchable immediately);
      // otherwise it waits to be spawned.
      active: true,
      alive: false,
      lastLocation: null,
      inGroup: null,
      parentLifeIds: parents.map((p) => p._id),
      isHeir: true
    };
    const owningParent = parents.find((p) => p.uid === ownerUid) || parents[0];
    const birthLoc = owningParent?.lastLocation && typeof owningParent.lastLocation.x === 'number'
      ? { x: owningParent.lastLocation.x, y: owningParent.lastLocation.y }
      : null;
    if (birthLoc) {
      insert.alive = true;
      insert.lastLocation = birthLoc;
    }
    const r = await db.collection('lives').insertOne(insert);
    if (birthLoc) {
      await _placeOnMap(db, worldId, ownerUid, r.insertedId, insert.name, owningParent?.race, birthLoc);
    }
    heirs.push({ ...insert, _id: r.insertedId });
  }
  return { ok: true, heirs };
}

export async function listHeirs(db, worldId, uid) {
  return db.collection('lives')
    .find({ worldId, uid, isHeir: true })
    .sort({ born: -1 })
    .toArray();
}
