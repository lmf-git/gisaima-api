import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { ITEMS } from 'gisaima-shared/definitions/ITEMS.js';
import { getResearch, highestAcademyLevel } from 'gisaima-shared/definitions/RESEARCH.js';
import { Ops } from '../../lib/ops.js';
import { canUse } from '../../structures/access.js';

const TICK_INTERVAL_MS = Number(process.env.TICK_INTERVAL_MS) || 60_000;

// Conduct research at a structure with an Academy. Completion is applied by the
// research tick, which sets structure.research[id] = true — the flag that unit
// recruitment gates check.
export async function startResearch({ uid, data, db }) {
  const { worldId, x, y, researchId } = data;
  if (!worldId || x === undefined || y === undefined || !researchId) {
    throw err(400, 'Missing required parameters');
  }

  const def = getResearch(researchId);
  if (!def) throw err(404, `Unknown research: ${researchId}`);

  const chunkKey = getChunkKey(x, y);
  const tileKey  = `${x},${y}`;
  const chunkDoc  = await db.collection('chunks').findOne({ worldId, chunkKey });
  const structure = chunkDoc?.tiles?.[tileKey]?.structure;
  if (!structure) throw err(404, 'Structure not found');
  if (structure.status === 'building') throw err(409, 'This structure is still being built');

  const allowed = await canUse({ db, worldId, structure, uid, action: 'recruit' });
  if (!allowed) throw err(403, 'You do not have permission to research at this structure');

  if (structure.research?.[researchId]) throw err(409, 'This research is already complete');
  if (structure.researchInProgress) throw err(409, 'This structure is already researching');

  const academyLevel = highestAcademyLevel(structure);
  if (academyLevel < def.requiredAcademyLevel) {
    throw err(409, `Requires an Academy of level ${def.requiredAcademyLevel}`);
  }
  if (def.requiredResearch && !structure.research?.[def.requiredResearch]) {
    throw err(409, `Requires ${getResearch(def.requiredResearch)?.name || def.requiredResearch} first`);
  }

  // Pay the cost from the structure: owner draws on the shared store + their
  // bank; non-owners only their own bank.
  const isOwner     = structure.owner === uid;
  const bankItems   = { ...(structure.banks?.[uid] || {}) };
  const sharedItems = isOwner ? { ...(structure.items || {}) } : {};
  const available = {};
  for (const [k, v] of Object.entries(bankItems))   available[k.toUpperCase()] = (available[k.toUpperCase()] || 0) + (v || 0);
  for (const [k, v] of Object.entries(sharedItems)) available[k.toUpperCase()] = (available[k.toUpperCase()] || 0) + (v || 0);

  for (const [code, qty] of Object.entries(def.cost || {})) {
    if ((available[code] || 0) < qty) {
      throw err(409, `Insufficient ${ITEMS[code]?.name || code}: need ${qty}, have ${available[code] || 0}`);
    }
  }
  // Deduct: bank first, then shared store.
  for (const [code, qty] of Object.entries(def.cost || {})) {
    let left = qty;
    if (bankItems[code]) { const t = Math.min(bankItems[code], left); bankItems[code] -= t; left -= t; if (bankItems[code] <= 0) delete bankItems[code]; }
    if (left > 0 && sharedItems[code]) { const t = Math.min(sharedItems[code], left); sharedItems[code] -= t; left -= t; if (sharedItems[code] <= 0) delete sharedItems[code]; }
  }

  const now         = Date.now();
  const completesAt = now + (def.ticksRequired || 1) * TICK_INTERVAL_MS;
  const research = {
    id: researchId, name: def.name, startedBy: uid, startedAt: now,
    completesAt, ticksRequired: def.ticksRequired || 1,
  };

  const ops = new Ops();
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.researchInProgress`, research);
  ops.chunk(worldId, chunkKey, `${tileKey}.structure.banks.${uid}`, bankItems);
  if (isOwner) ops.chunk(worldId, chunkKey, `${tileKey}.structure.items`, sharedItems);
  ops.chat(worldId, {
    location: { x, y },
    text: `Research begun: ${def.name}.`,
    timestamp: now, type: 'event', category: 'player', userId: uid
  });

  await ops.flush(db);
  return { success: true, researchId, completesAt };
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export default startResearch;
