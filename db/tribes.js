import { ObjectId } from 'mongodb';

export async function getWorldTribes(db, worldId) {
  return db.collection('tribes').find({ worldId }).sort({ createdAt: 1 }).toArray();
}

export async function getTribeById(db, tribeId) {
  return db.collection('tribes').findOne({ _id: new ObjectId(tribeId) });
}

export async function createTribe(db, worldId, leaderId, leaderName, name, tag, description) {
  const doc = {
    worldId,
    name,
    tag: tag.toUpperCase().slice(0, 5),
    leaderId,
    leaderName,
    description: description || '',
    members: [{ uid: leaderId, displayName: leaderName, joinedAt: Date.now() }],
    createdAt: Date.now(),
  };
  const result = await db.collection('tribes').insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

export async function addMemberToTribe(db, tribeId, uid, displayName) {
  return db.collection('tribes').updateOne(
    { _id: new ObjectId(tribeId) },
    { $push: { members: { uid, displayName, joinedAt: Date.now() } } }
  );
}

export async function removeMemberFromTribe(db, tribeId, uid) {
  return db.collection('tribes').updateOne(
    { _id: new ObjectId(tribeId) },
    { $pull: { members: { uid } } }
  );
}

export async function deleteTribe(db, tribeId) {
  return db.collection('tribes').deleteOne({ _id: new ObjectId(tribeId) });
}

export async function getPlayerTribe(db, worldId, uid) {
  return db.collection('tribes').findOne({ worldId, 'members.uid': uid });
}

export async function getRankings(db, worldId) {
  const [players, chunks] = await Promise.all([
    db.collection('players').find(
      { [`worlds.${worldId}`]: { $exists: true } },
      { projection: { _id: 1, [`worlds.${worldId}.displayName`]: 1, [`worlds.${worldId}.kills`]: 1 } }
    ).toArray(),
    db.collection('chunks').find({ worldId }, { projection: { tiles: 1 } }).toArray(),
  ]);

  // Aggregate structure ownership and points from chunks
  const structureStats = {};
  for (const chunk of chunks) {
    for (const tile of Object.values(chunk.tiles || {})) {
      const s = tile.structure;
      if (!s?.owner || !s.isCenter) continue;
      if (!structureStats[s.owner]) structureStats[s.owner] = { count: 0, points: 0 };
      structureStats[s.owner].count += 1;
      // Points: structure level + sum of all building levels
      let pts = s.level || 1;
      for (const b of Object.values(s.buildings || {})) pts += (b.level || 1);
      structureStats[s.owner].points += pts;
    }
  }

  const rows = players.map(p => {
    const wd = p.worlds?.[worldId] || {};
    const ss = structureStats[p._id] || { count: 0, points: 0 };
    return {
      uid:            p._id,
      displayName:    wd.displayName || 'Unknown',
      kills:          wd.kills || 0,
      structureCount: ss.count,
      structurePoints: ss.points,
    };
  });

  return {
    kills:      [...rows].sort((a, b) => b.kills - a.kills).slice(0, 20),
    structures: [...rows].sort((a, b) => b.structureCount - a.structureCount).slice(0, 20),
    points:     [...rows].sort((a, b) => b.structurePoints - a.structurePoints).slice(0, 20),
  };
}
