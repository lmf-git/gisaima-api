/**
 * Monster population control — keep monster groups/structures bounded so a
 * long-running world doesn't accumulate them until the tick jams.
 *
 * Two mechanisms, both player-aware:
 *   1. Cap   — max monster groups / structures scales with the number of
 *              *active* players on the world (more players → busier world is
 *              allowed; an empty world decays back toward an ambient floor).
 *   2. Aging — idle monster groups (and old monster structures) past a max
 *              age are removed even when under the cap, so stragglers in
 *              far-flung corners don't pile up forever.
 *
 * SAFETY (never remove anything mid-interaction, which would dangle a
 * reference and crash a later tick):
 *   - Reads FRESH chunk state from the db and runs LAST in the tick, after all
 *     other processors have flushed. The `chunks` snapshot tick.js loads at the
 *     start is NOT mutated by ops (ops only stage db writes), so a monster that
 *     entered a battle or began demobilising *this* tick is invisible there.
 *     Re-reading avoids removing something that just became busy.
 *   - A monster group is only ever removable when status === 'idle' and it is
 *     not in / pending a battle.
 *   - A monster structure is protected while building, besieged, mid-conquer,
 *     on a tile with an active battle, OR while any monster group is
 *     demobilising into it / moving toward it / has it reserved
 *     (targetStructureId / preferredStructureId / targetStructure coords).
 */

const MONSTER_GROUP_BASE_CAP     = 30;  // ambient groups allowed with zero active players
const MONSTER_GROUPS_PER_PLAYER  = 20;
const MONSTER_STRUCT_BASE_CAP    = 6;
const MONSTER_STRUCTS_PER_PLAYER = 3;
const MONSTER_MAX_AGE_DAYS       = 5;   // idle group aged out after this many in-game days
const STRUCT_MAX_AGE_DAYS        = 30;  // monster structure aged out after this many

const TICKS_PER_GAME_DAY = 24;          // matches db/cleanup.js cadence
const INACTIVE_AFTER_DAYS = 7;          // a player quieter than this isn't "active"

function _effectiveTickMs(worldInfo) {
  const tickIntervalMs = Number(worldInfo?.tickInterval ?? worldInfo?.tickMs ?? 60_000);
  const speed = Math.max(0.01, Number(worldInfo?.speed) || 1);
  return tickIntervalMs / speed;
}

function _toMs(ts) {
  if (ts == null) return NaN;
  const t = typeof ts === 'number' ? ts : new Date(ts).getTime();
  return Number.isFinite(t) ? t : NaN;
}

// Spawn time is embedded in monster ids: `monster_<ts>_<rand>` or
// `monster_structure_<ts>_<rand>`. The timestamp is the second-from-last
// underscore segment in both shapes.
function _idTimestamp(id) {
  if (typeof id !== 'string') return NaN;
  const parts = id.split('_');
  return _toMs(parts[parts.length - 2]);
}

function _ageDays(entity, id, worldInfo, now) {
  let created = _toMs(entity?.createdAt);
  if (!Number.isFinite(created)) created = _idTimestamp(id);
  if (!Number.isFinite(created)) return 0; // unknown age → treat as new, never age out
  const ticks = (now - created) / _effectiveTickMs(worldInfo);
  return ticks / TICKS_PER_GAME_DAY;
}

function _groupProtected(tile, group) {
  if (group?.status !== 'idle') return true;           // moving/gathering/building/demobilising/fighting
  if (group?.battleId || group?.pendingBattleFromUid) return true;
  if (tile?.battles && Object.keys(tile.battles).length > 0) return true;
  return false;
}

function _structProtected(tile, structure, referencedIds, targetedCoords, tileKey, hasDemobOnTile) {
  // Completed monster structures clear their status (buildTick unsets it); a
  // present status means building/ruin/etc. → not safe to remove.
  if (structure?.status && structure.status !== 'active') return true;
  if (structure?.besieged) return true;
  if (structure?.conqueredAt && !structure?.conquerResolvedAt) return true;
  if (tile?.battles && Object.keys(tile.battles).length > 0) return true;
  if (hasDemobOnTile) return true;
  if (structure?.id && referencedIds.has(structure.id)) return true;
  if (targetedCoords.has(tileKey)) return true;
  return false;
}

// Pull fresh chunk docs from the db into a { chunkKey: tiles } map.
async function _loadChunks(db, worldId) {
  const out = {};
  const cursor = db.collection('chunks').find({ worldId }, { projection: { chunkKey: 1, tiles: 1 } });
  for await (const doc of cursor) {
    out[doc.chunkKey] = doc.tiles || {};
  }
  return out;
}

async function _countActivePlayers(db, worldId, worldInfo, now) {
  const players = await db.collection('players').find(
    { [`worlds.${worldId}`]: { $exists: true } },
    { projection: { [`worlds.${worldId}.lastSeen`]: 1, [`worlds.${worldId}.alive`]: 1 } }
  ).toArray();
  const inactiveDays = Number(worldInfo?.cleanup?.inactiveAfterDays ?? INACTIVE_AFTER_DAYS);
  const tickMs = _effectiveTickMs(worldInfo);
  let count = 0;
  for (const p of players) {
    const w = p.worlds?.[worldId];
    if (!w || w.alive === false) continue;
    const t = _toMs(w.lastSeen);
    if (!Number.isFinite(t)) continue;
    const days = ((now - t) / tickMs) / TICKS_PER_GAME_DAY;
    if (days < inactiveDays) count++;
  }
  return count;
}

/**
 * Run one monster-population pass. Reads fresh chunk state itself; the caller
 * supplies a fresh `ops` to flush. Returns counts for logging.
 */
export async function tick(db, worldId, ops, worldInfo = null) {
  const out = {
    activePlayers: 0, groupCap: 0, structCap: 0,
    monsterGroups: 0, monsterStructs: 0,
    agedGroups: 0, cappedGroups: 0, agedStructs: 0, cappedStructs: 0
  };
  const now = Date.now();

  const cap = worldInfo?.monsterCap || {};
  out.activePlayers = await _countActivePlayers(db, worldId, worldInfo, now);
  const groupCap = Math.round((cap.groupBase ?? MONSTER_GROUP_BASE_CAP)
    + (cap.groupsPerPlayer ?? MONSTER_GROUPS_PER_PLAYER) * out.activePlayers);
  const structCap = Math.round((cap.structBase ?? MONSTER_STRUCT_BASE_CAP)
    + (cap.structsPerPlayer ?? MONSTER_STRUCTS_PER_PLAYER) * out.activePlayers);
  const maxGroupAgeDays = cap.maxGroupAgeDays ?? MONSTER_MAX_AGE_DAYS;
  const maxStructAgeDays = cap.maxStructAgeDays ?? STRUCT_MAX_AGE_DAYS;
  out.groupCap = groupCap;
  out.structCap = structCap;

  const chunks = await _loadChunks(db, worldId);

  // Pass A — collect references that protect structures from removal.
  const referencedIds = new Set();   // structure ids a group is heading to / reserved for
  const targetedCoords = new Set();  // "x,y" of structures a group is moving toward
  const demobTiles = new Set();      // "chunkKey|tileKey" with a demobilising monster group
  for (const [chunkKey, tiles] of Object.entries(chunks)) {
    for (const [tileKey, tile] of Object.entries(tiles || {})) {
      if (!tile?.groups) continue;
      for (const g of Object.values(tile.groups)) {
        if (g?.targetStructureId) referencedIds.add(g.targetStructureId);
        if (g?.preferredStructureId) referencedIds.add(g.preferredStructureId);
        if (g?.targetStructure && Number.isFinite(g.targetStructure.x)) {
          targetedCoords.add(`${g.targetStructure.x},${g.targetStructure.y}`);
        }
        if (g?.type === 'monster' && g?.status === 'demobilising') {
          demobTiles.add(`${chunkKey}|${tileKey}`);
        }
      }
    }
  }

  // Pass B — collect removable candidates and census totals.
  const groupCandidates = [];
  const structCandidates = [];
  for (const [chunkKey, tiles] of Object.entries(chunks)) {
    for (const [tileKey, tile] of Object.entries(tiles || {})) {
      if (!tile) continue;

      if (tile.structure?.monster === true) {
        out.monsterStructs++;
        const s = tile.structure;
        const hasDemob = demobTiles.has(`${chunkKey}|${tileKey}`);
        if (!_structProtected(tile, s, referencedIds, targetedCoords, tileKey, hasDemob)) {
          structCandidates.push({ chunkKey, tileKey, id: s.id, ageDays: _ageDays(s, s.id, worldInfo, now) });
        }
      }

      if (tile.groups) {
        for (const [gid, g] of Object.entries(tile.groups)) {
          if (g?.type !== 'monster') continue;
          out.monsterGroups++;
          if (_groupProtected(tile, g)) continue;
          groupCandidates.push({ chunkKey, tileKey, gid, group: g, ageDays: _ageDays(g, gid, worldInfo, now) });
        }
      }
    }
  }

  // Oldest first — aging and cap-trimming both prefer removing the eldest.
  groupCandidates.sort((a, b) => b.ageDays - a.ageDays);
  structCandidates.sort((a, b) => b.ageDays - a.ageDays);

  const dropGroupItems = (c, reason) => {
    if (c.group?.items && Object.keys(c.group.items).length) {
      const [x, y] = c.tileKey.split(',').map(Number);
      db.collection('item_drops').insertOne({
        worldId, x, y, items: c.group.items, droppedAt: new Date(), from: 'monster', reason
      }).catch(() => {});
    }
  };

  // --- Groups: age out, then trim to cap ---
  const removedGroups = new Set();
  for (const c of groupCandidates) {
    if (c.ageDays >= maxGroupAgeDays) {
      dropGroupItems(c, 'monster_age');
      ops.chunk(worldId, c.chunkKey, `${c.tileKey}.groups.${c.gid}`, null);
      removedGroups.add(c.gid);
      out.agedGroups++;
    }
  }
  let liveGroups = out.monsterGroups - out.agedGroups;
  if (liveGroups > groupCap) {
    for (const c of groupCandidates) {
      if (liveGroups <= groupCap) break;
      if (removedGroups.has(c.gid)) continue;
      dropGroupItems(c, 'monster_cap');
      ops.chunk(worldId, c.chunkKey, `${c.tileKey}.groups.${c.gid}`, null);
      removedGroups.add(c.gid);
      out.cappedGroups++;
      liveGroups--;
    }
  }

  // --- Structures: age out, then trim to cap ---
  const removedStructs = new Set();
  for (const c of structCandidates) {
    if (c.ageDays >= maxStructAgeDays) {
      ops.chunk(worldId, c.chunkKey, `${c.tileKey}.structure`, null);
      removedStructs.add(c.id);
      out.agedStructs++;
    }
  }
  let liveStructs = out.monsterStructs - out.agedStructs;
  if (liveStructs > structCap) {
    for (const c of structCandidates) {
      if (liveStructs <= structCap) break;
      if (removedStructs.has(c.id)) continue;
      ops.chunk(worldId, c.chunkKey, `${c.tileKey}.structure`, null);
      removedStructs.add(c.id);
      out.cappedStructs++;
      liveStructs--;
    }
  }

  return out;
}
