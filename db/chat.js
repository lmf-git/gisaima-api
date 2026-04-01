export async function insertChatMessage(db, worldId, msg) {
  const doc = { worldId, ...msg };
  const result = await db.collection('chat').insertOne(doc);
  return result.insertedId;
}

/** Keep only the most recent `keep` messages for a world */
export async function trimChatMessages(db, worldId, keep = 500) {
  const cursor = db.collection('chat')
    .find({ worldId }, { projection: { _id: 1 } })
    .sort({ timestamp: -1 })
    .skip(keep);
  const toDelete = await cursor.toArray();
  if (!toDelete.length) return 0;
  const ids = toDelete.map(d => d._id);
  const { deletedCount } = await db.collection('chat').deleteMany({ _id: { $in: ids } });
  return deletedCount;
}

export async function getRecentChat(db, worldId, limit = 100) {
  return db.collection('chat')
    .find({ worldId })
    .sort({ timestamp: -1 })
    .limit(limit)
    .toArray()
    .then(msgs => msgs.reverse()); // oldest-first
}
