export async function getWorldDoc(db, worldId) {
  return db.collection('worlds').findOne({ _id: worldId });
}

export async function upsertWorldInfo(db, worldId, infoFields) {
  const $set = {};
  for (const [k, v] of Object.entries(infoFields)) $set[`info.${k}`] = v;
  await db.collection('worlds').updateOne({ _id: worldId }, { $set }, { upsert: true });
}

export async function getAllWorldIds(db) {
  const docs = await db.collection('worlds').find({}, { projection: { _id: 1 } }).toArray();
  return docs.map(d => d._id);
}

/**
 * Loads all worlds and assembles the same nested object shape the Firebase
 * tick code expects:
 *   { worldId: { info, upgrades, crafting, chunks: { chunkKey: { tileKey: tileData } }, chat: { msgId: msg } } }
 *
 * By default only chunks flagged `active` (or with no flag yet — legacy/new
 * docs) are loaded, so inert explored terrain costs nothing per tick. Pass
 * `{ activeOnly: false }` for the periodic full sweep that reconciles flags.
 */
export async function loadAllWorlds(db, { activeOnly = true } = {}) {
  const worldDocs = await db.collection('worlds').find({}).toArray();
  const result = {};

  // `active: { $ne: false }` matches active:true AND docs missing the field,
  // so a chunk is only ever skipped once the tick has explicitly demoted it.
  const chunkFilter = activeOnly
    ? (worldId) => ({ worldId, active: { $ne: false } })
    : (worldId) => ({ worldId });

  await Promise.all(worldDocs.map(async world => {
    const worldId = world._id;

    const [chunkDocs, chatDocs] = await Promise.all([
      db.collection('chunks').find(chunkFilter(worldId)).toArray(),
      db.collection('chat').find({ worldId }).sort({ timestamp: 1 }).toArray()
    ]);

    const chunksObj = {};
    for (const c of chunkDocs) chunksObj[c.chunkKey] = c.tiles || {};

    const chatObj = {};
    for (const m of chatDocs) {
      chatObj[m._id.toString()] = {
        text:      m.text,
        type:      m.type      || 'user',
        timestamp: m.timestamp,
        userId:    m.userId,
        userName:  m.userName,
        location:  m.location  || null
      };
    }

    result[worldId] = {
      info:     world.info     || {},
      upgrades: world.upgrades || null,
      crafting: world.crafting || null,
      chunks:   chunksObj,
      chat:     chatObj
    };
  }));

  return result;
}
