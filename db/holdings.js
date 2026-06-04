// Player holdings — every structure and unit group a player owns across the
// world, with their stored items and locations. Backs the resource modal's
// "expand to all holdings" view. This scans the world's chunks (same cost as
// wealthRankings); call it on demand, not per tick.

// A structure can launch ships (naval trade) if it has a harbour building.
function _hasHarbour(structure) {
  const b = structure?.buildings || {};
  return Object.keys(b).some(k => {
    const key = k.toLowerCase();
    return key.includes('harbour') || key.includes('harbor') || key.includes('dock') || key.includes('port');
  });
}

// Count non-player units garrisoned at a structure — these crew trade shipments.
function _crewUnits(structure) {
  const units = structure?.units;
  if (!units) return 0;
  const list = Array.isArray(units) ? units : Object.values(units);
  return list.reduce((n, u) => n + (u && u.type !== 'player' ? (Number(u.quantity) || 0) : 0), 0);
}

export async function getPlayerHoldings(db, worldId, uid) {
  if (!uid) return { structures: [], groups: [] };

  const chunks = await db.collection('chunks')
    .find({ worldId }, { projection: { tiles: 1 } })
    .toArray();

  const structures = [];
  const groups = [];

  for (const chunk of chunks) {
    for (const [tileKey, tile] of Object.entries(chunk.tiles || {})) {
      if (!tile) continue;
      const [x, y] = tileKey.split(',').map(Number);

      const s = tile.structure;
      if (s?.owner === uid) {
        structures.push({
          x, y,
          name: s.name || null,
          type: s.type || null,
          items: s.items || {},
          harbour: _hasHarbour(s),
          crewUnits: _crewUnits(s),
        });
      }

      for (const [groupId, g] of Object.entries(tile.groups || {})) {
        if (g?.owner !== uid) continue;
        groups.push({
          x, y,
          id: groupId,
          name: g.name || null,
          status: g.status || 'idle',
          items: g.items || {},
        });
      }
    }
  }

  return { structures, groups };
}
