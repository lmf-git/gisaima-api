export async function getPlayerWorldData(db, userId, worldId) {
  const doc = await db.collection('players').findOne(
    { _id: userId },
    { projection: { [`worlds.${worldId}`]: 1 } }
  );
  return doc?.worlds?.[worldId] ?? null;
}

export async function setPlayerWorldData(db, userId, worldId, data) {
  await db.collection('players').updateOne(
    { _id: userId },
    { $set: { [`worlds.${worldId}`]: data } },
    { upsert: true }
  );
}

export async function patchPlayerWorldData(db, userId, worldId, fields) {
  const $set = {};
  for (const [k, v] of Object.entries(fields)) $set[`worlds.${worldId}.${k}`] = v;
  await db.collection('players').updateOne({ _id: userId }, { $set }, { upsert: true });
}

export async function getPlayerJoinedWorlds(db, userId) {
  const doc = await db.collection('players').findOne(
    { _id: userId },
    { projection: { worlds: 1 } }
  );
  return doc?.worlds ? Object.keys(doc.worlds) : [];
}

/** Atomically increment world.info.playerCount — safe under concurrent requests */
export async function incrementPlayerCount(db, worldId) {
  await db.collection('worlds').updateOne(
    { _id: worldId },
    { $inc: { 'info.playerCount': 1 } },
    { upsert: true }
  );
}
