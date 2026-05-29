/**
 * Add a new (level 1) building to a structure, spending the structure's shared
 * item pool. Gated by the structure's `build` access tier (spawns → same race).
 *
 * Body: { worldId, x, y, buildingType, subCell? }
 *   subCell is a flat subgrid index (row*subN + col); if omitted/occupied a free
 *   cell is chosen automatically.
 */
import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { BUILDINGS } from 'gisaima-shared';
import { ITEMS } from 'gisaima-shared/definitions/ITEMS.js';
import { Ops } from '../../lib/ops.js';
import { canUse } from '../../structures/access.js';

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

// Resolve a display name or loose id to a canonical ITEMS code.
function nameToCode(name) {
  if (!name) return '';
  if (ITEMS[name]) return name;
  const byName = Object.keys(ITEMS).find(k => ITEMS[k].name === name);
  if (byName) return byName;
  const up = name.toUpperCase().replace(/ /g, '_');
  return ITEMS[up] ? up : up;
}

function codeOf(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return nameToCode(entry);
  if (entry.id && ITEMS[entry.id]) return entry.id;
  return nameToCode(entry.name || entry.id || '');
}

const subgridSize = (level = 0) => (level >= 5 ? 5 : level >= 3 ? 4 : 3);

export async function addBuilding({ uid, data, db }) {
  const { worldId, x, y, buildingType } = data || {};
  let { subCell } = data || {};
  if (!worldId || x === undefined || y === undefined || !buildingType) {
    throw err(400, 'Missing required parameters');
  }

  const def = BUILDINGS.types[buildingType];
  if (!def)        throw err(400, `Unknown building type: ${buildingType}`);
  if (def.monster) throw err(400, 'Cannot construct monster buildings');

  const chunkKey = getChunkKey(x, y);
  const tileKey  = `${x},${y}`;
  const chunkDoc  = await db.collection('chunks').findOne({ worldId, chunkKey });
  const structure = chunkDoc?.tiles?.[tileKey]?.structure;
  if (!structure)                   throw err(404, 'Structure not found');
  if (structure.status === 'building') throw err(409, 'Structure is still under construction');

  const allowed = await canUse({ db, worldId, structure, uid, action: 'build' });
  if (!allowed) throw err(403, 'You do not have permission to build at this structure');

  const buildings = { ...(structure.buildings || {}) };
  if (Object.values(buildings).some(b => b.type === buildingType)) {
    throw err(409, 'This structure already has that building');
  }

  // Slot limit: spawns allow up to 5, otherwise one per structure level.
  const isSpawn = structure.type === 'spawn';
  const cap = isSpawn ? 5 : (structure.level || 1);
  if (Object.keys(buildings).length >= cap) throw err(409, 'No building slots available');

  // --- Resource check & spend from the shared pool (preserve container shape) ---
  const reqs = def.baseRequirements || [];
  const isArr = Array.isArray(structure.items);

  const avail = {};
  if (isArr) {
    for (const it of structure.items) {
      const c = codeOf(it);
      if (c) avail[c] = (avail[c] || 0) + (it.quantity || 0);
    }
  } else if (structure.items && typeof structure.items === 'object') {
    for (const [k, v] of Object.entries(structure.items)) avail[k.toUpperCase()] = v;
  }

  const missing = [];
  const spend = {};
  for (const r of reqs) {
    const code = nameToCode(r.name);
    spend[code] = (spend[code] || 0) + r.quantity;
  }
  for (const [code, need] of Object.entries(spend)) {
    if ((avail[code] || 0) < need) {
      missing.push(`${ITEMS[code]?.name || code} (${avail[code] || 0}/${need})`);
    }
  }
  if (missing.length) throw err(409, `Missing resources: ${missing.join(', ')}`);

  // Build the updated item container.
  let updatedItems;
  if (isArr) {
    updatedItems = structure.items
      .map(it => {
        const c = codeOf(it);
        const take = spend[c] || 0;
        if (!take) return it;
        const remaining = (it.quantity || 0) - take;
        spend[c] = 0;
        return remaining > 0 ? { ...it, quantity: remaining } : null;
      })
      .filter(Boolean);
  } else {
    updatedItems = { ...(structure.items || {}) };
    for (const [code, need] of Object.entries(spend)) {
      const key = Object.keys(updatedItems).find(k => k.toUpperCase() === code) || code;
      const remaining = (updatedItems[key] || 0) - need;
      if (remaining > 0) updatedItems[key] = remaining; else delete updatedItems[key];
    }
  }

  // --- Choose a free subgrid cell ---
  const subN = subgridSize(structure.level || 0);
  const center = Math.floor(subN / 2);
  const iconRow = Number.isInteger(structure.subRow) ? structure.subRow : center;
  const iconCol = Number.isInteger(structure.subCol) ? structure.subCol : center;
  const occupied = new Set(Object.values(buildings).map(b => `${b.subRow}-${b.subCol}`));
  occupied.add(`${iconRow}-${iconCol}`);

  let subRow, subCol;
  if (Number.isInteger(subCell)) {
    const r = Math.floor(subCell / subN), c = subCell % subN;
    if (!occupied.has(`${r}-${c}`) && r < subN && c < subN) { subRow = r; subCol = c; }
  }
  if (subRow === undefined) {
    for (let r = 0; r < subN && subRow === undefined; r++) {
      for (let c = 0; c < subN; c++) {
        if (!occupied.has(`${r}-${c}`)) { subRow = r; subCol = c; break; }
      }
    }
  }
  if (subRow === undefined) throw err(409, 'No free space to place the building');

  const id = `building_${buildingType}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const building = {
    id, type: buildingType, name: def.name || buildingType,
    level: 1, subRow, subCol,
    ...(structure.race ? { race: structure.race } : {}),
  };

  const ops = new Ops();
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.buildings.${id}`, building);
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.items`, updatedItems);
  ops.chat(worldId, {
    type: 'event', category: 'player', userId: uid,
    text: `A ${building.name} has been built at (${x},${y})`,
    timestamp: Date.now(), location: { x, y },
  });
  await ops.flush(db);

  return { success: true, building };
}

export default addBuilding;
