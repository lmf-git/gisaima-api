/**
 * Starter-building generator.
 *
 * New player-built structures and the race spawns should not present an empty
 * subdivided tile. This produces a `buildings` map (keyed by buildingId) of a
 * few low-level (level 1) buildings positioned on the structure's subgrid,
 * deliberately skipping the cell occupied by the structure icon.
 *
 * Kept server-side (rather than in gisaima-shared) so it can ship without
 * republishing the pinned shared package. The client only reads
 * `building.subRow/subCol` to render — it does not need this generator.
 */
import { BUILDINGS } from 'gisaima-shared';

// Generic low-level set for a player-built structure.
const PLAYER_STARTER_TYPES = ['smithy', 'farm', 'market'];
// Richer community set for race spawns (StructureOverview caps spawns at 5).
const SPAWN_STARTER_TYPES = ['barracks', 'smithy', 'farm', 'market', 'academy'];

/**
 * Returns the subgrid cells (row,col) ordered outermost-first (perimeter before
 * inner cells), excluding the structure icon cell, so buildings spread out and
 * never overlap the structure glyph.
 */
function placementCells(subN, iconRow, iconCol) {
  const center = Math.floor(subN / 2);
  const cells = [];
  for (let row = 0; row < subN; row++) {
    for (let col = 0; col < subN; col++) {
      if (row === iconRow && col === iconCol) continue;
      // Chebyshev distance from centre — larger = closer to the perimeter.
      const ring = Math.max(Math.abs(row - center), Math.abs(col - center));
      cells.push({ row, col, ring });
    }
  }
  // Perimeter first; stable within a ring for deterministic output.
  cells.sort((a, b) => b.ring - a.ring);
  return cells;
}

/**
 * @param {object} opts
 * @param {string} opts.structureId - parent structure id (used to build building ids)
 * @param {string} [opts.race]
 * @param {boolean} [opts.isSpawn]
 * @param {number} [opts.subN=3] - subgrid dimension (3 for level < 3)
 * @param {number} [opts.iconRow] - structure icon row (defaults to centre)
 * @param {number} [opts.iconCol] - structure icon col (defaults to centre)
 * @returns {Record<string, object>} buildings map
 */
export function getStarterBuildings({
  structureId,
  race = null,
  isSpawn = false,
  subN = 3,
  iconRow,
  iconCol,
} = {}) {
  const center = Math.floor(subN / 2);
  const r = Number.isInteger(iconRow) ? iconRow : center;
  const c = Number.isInteger(iconCol) ? iconCol : center;

  const types = isSpawn ? SPAWN_STARTER_TYPES : PLAYER_STARTER_TYPES;
  const cells = placementCells(subN, r, c);

  const buildings = {};
  types.forEach((type, i) => {
    const cell = cells[i];
    if (!cell) return; // ran out of room — keep what fits
    const def = BUILDINGS.types[type];
    if (!def) return;
    const id = `building_${type}_${structureId || 'structure'}`;
    buildings[id] = {
      id,
      type,
      name: def.name || type,
      level: 1,
      subRow: cell.row,
      subCol: cell.col,
      ...(race ? { race } : {}),
    };
  });

  return buildings;
}

export default getStarterBuildings;
