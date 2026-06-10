// World standings, broken down by player, tribe and house. Lives in its own
// module (rather than tribes.js) because it spans players, structures, tribes
// and houses — it's not tribe-specific.

export async function getRankings(db, worldId) {
  const [players, chunks, tribes] = await Promise.all([
    db.collection('players').find(
      { [`worlds.${worldId}`]: { $exists: true } },
      { projection: {
          _id: 1,
          [`worlds.${worldId}.displayName`]: 1,
          [`worlds.${worldId}.kills`]: 1,
          [`worlds.${worldId}.gold`]: 1,
          [`worlds.${worldId}.distance`]: 1,
          [`worlds.${worldId}.hideFromRankings`]: 1,
          [`worlds.${worldId}.houseId`]: 1,
          [`worlds.${worldId}.houseName`]: 1,
      } }
    ).toArray(),
    db.collection('chunks').find({ worldId }, { projection: { tiles: 1 } }).toArray(),
    db.collection('tribes').find({ worldId }).toArray(),
  ]);

  // Aggregate structure ownership and points from chunks
  const structureStats = {};
  for (const chunk of chunks) {
    for (const tile of Object.values(chunk.tiles || {})) {
      const s = tile.structure;
      if (!s?.owner) continue;
      if (!structureStats[s.owner]) structureStats[s.owner] = { count: 0, points: 0 };
      structureStats[s.owner].count += 1;
      let pts = s.level || 1;
      for (const b of Object.values(s.buildings || {})) pts += (b.level || 1);
      structureStats[s.owner].points += pts;
    }
  }

  // Player rows
  const rows = players.map(p => {
    const wd = p.worlds?.[worldId] || {};
    const ss = structureStats[p._id] || { count: 0, points: 0 };
    return {
      uid:             p._id,
      displayName:     wd.displayName || 'Unknown',
      houseId:         wd.houseId || null,
      houseName:       wd.houseName || null,
      kills:           wd.kills || 0,
      wealth:          wd.gold || 0,
      distance:        wd.distance || 0,
      hidden:          wd.hideFromRankings === true,
      structureCount:  ss.count,
      structurePoints: ss.points,
    };
  });

  // Privacy — players who opted out are anonymised in the public boards (the
  // notes ask for "rankings for wealth unless player hides name").
  const publicRows = rows.map(r => r.hidden ? { ...r, uid: null, displayName: 'Anonymous' } : r);

  // House rows — sum the stats of every sworn member. Players with no house are
  // omitted. Keyed by houseId when present, falling back to houseName.
  const houseMap = new Map();
  for (const r of rows) {
    if (!r.houseId && !r.houseName) continue;
    const key = r.houseId || `name:${r.houseName}`;
    let h = houseMap.get(key);
    if (!h) {
      h = { houseId: r.houseId, name: r.houseName || 'Unnamed House', memberCount: 0, kills: 0, structureCount: 0, structurePoints: 0 };
      houseMap.set(key, h);
    }
    h.memberCount     += 1;
    h.kills           += r.kills;
    h.structureCount  += r.structureCount;
    h.structurePoints += r.structurePoints;
  }
  const houseRows = [...houseMap.values()];

  // Build quick-lookup maps for tribe aggregation
  const killsByUid          = Object.fromEntries(rows.map(r => [r.uid, r.kills]));
  const structureStatsByUid = Object.fromEntries(rows.map(r => [r.uid, { count: r.structureCount, points: r.structurePoints }]));

  // Tribe rows — sum member stats
  const tribeRows = tribes.map(t => {
    let kills = 0, structureCount = 0, structurePoints = 0;
    for (const m of (t.members || [])) {
      kills           += killsByUid[m.uid]                     || 0;
      structureCount  += structureStatsByUid[m.uid]?.count     || 0;
      structurePoints += structureStatsByUid[m.uid]?.points    || 0;
    }
    return {
      tribeId:         t._id.toString(),
      name:            t.name,
      tag:             t.tag,
      memberCount:     (t.members || []).length,
      kills,
      structureCount,
      structurePoints,
    };
  });

  const top = (arr, key) => [...arr].sort((a, b) => b[key] - a[key]).slice(0, 20);

  // Cache each player's standing points back onto their doc. The Chronicle reads
  // this when deciding whether a slain player was notable enough to record.
  if (rows.length) {
    db.collection('players').bulkWrite(
      rows.map(r => ({
        updateOne: {
          filter: { _id: r.uid },
          update: { $set: { [`worlds.${worldId}.points`]: r.structurePoints } },
        },
      })),
      { ordered: false }
    ).catch(() => {});
  }

  return {
    // By player
    kills:            top(publicRows, 'kills'),
    structures:       top(publicRows, 'structureCount'),
    points:           top(publicRows, 'structurePoints'),
    wealth:           top(publicRows, 'wealth'),
    distance:         top(publicRows, 'distance'),
    // By tribe
    tribeKills:       top(tribeRows, 'kills'),
    tribeStructures:  top(tribeRows, 'structureCount'),
    tribePoints:      top(tribeRows, 'structurePoints'),
    // By house
    houseKills:       top(houseRows, 'kills'),
    houseStructures:  top(houseRows, 'structureCount'),
    housePoints:      top(houseRows, 'structurePoints'),
  };
}
