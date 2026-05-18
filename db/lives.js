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

const SPAWN_STORE_CAP = 200;

export async function listFor(db, worldId, uid) {
  return db.collection('lives')
    .find({ worldId, uid })
    .sort({ born: -1 })
    .toArray();
}

export async function currentLife(db, worldId, uid) {
  return db.collection('lives').findOne({ worldId, uid, died: null });
}

export async function birth(db, { worldId, uid, name, parentLifeId = null }) {
  const insert = {
    worldId, uid, name,
    born: new Date(),
    died: null,
    deeds: 0,
    parentLifeId: parentLifeId ? new ObjectId(parentLifeId) : null
  };
  const r = await db.collection('lives').insertOne(insert);
  await db.collection('players').updateOne(
    { _id: uid },
    {
      $set: {
        [`worlds.${worldId}.displayName`]: name,
        [`worlds.${worldId}.alive`]: true,
        [`worlds.${worldId}.currentLifeId`]: r.insertedId
      }
    },
    { upsert: true }
  );
  return { ...insert, _id: r.insertedId };
}

export async function addDeath(db, worldId, uid, { cause = 'unknown', by = null, at = new Date(), inventory = null, location = null } = {}) {
  const life = await currentLife(db, worldId, uid);
  if (life) {
    await db.collection('lives').updateOne(
      { _id: life._id },
      { $set: { died: at, cause, by, deathLocation: location } }
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

export async function reproduce(db, worldId, parentLifeIds = []) {
  if (!parentLifeIds.length) throw new Error('at least one parent required');
  const _ids = parentLifeIds.map((id) => new ObjectId(id));
  const parents = await db.collection('lives').find({ _id: { $in: _ids } }).toArray();
  if (!parents.length) throw new Error('parents not found');

  const ethnicity = _pickEthnicity(parents);
  const trait     = _pickTrait(parents);
  const ownerUid  = parents[0].uid;

  const count = _howManyChildren();
  const heirs = [];
  for (let i = 0; i < count; i++) {
    const sex = SEX_OPTIONS[Math.floor(Math.random() * SEX_OPTIONS.length)];
    const baseName = parents[0].name?.split(' ')?.[0] || 'Heir';
    const insert = {
      worldId,
      uid: ownerUid,
      name: `${baseName} the ${trait}${count > 1 ? ` (${i + 1})` : ''}`,
      born: new Date(),
      died: null,
      deeds: 0,
      sex,
      ethnicity,
      trait,
      parentLifeIds: parents.map((p) => p._id),
      isHeir: true
    };
    const r = await db.collection('lives').insertOne(insert);
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
