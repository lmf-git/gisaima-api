/**
 * Research tick — completes in-progress research at structures.
 *
 * Scans loaded chunks for structures whose `researchInProgress.completesAt` has
 * passed, sets `structure.research[id] = true` (the flag unit recruitment gates
 * read) and clears the in-progress marker.
 */
import { Ops } from '../lib/ops.js';

export async function processResearch(worldId, worldData, db) {
  const chunks = worldData?.chunks;
  if (!chunks) return { processed: 0 };

  const now = Date.now();
  const ops = new Ops();
  let processed = 0;

  for (const [chunkKey, tiles] of Object.entries(chunks)) {
    for (const [tileKey, tile] of Object.entries(tiles || {})) {
      const r = tile?.structure?.researchInProgress;
      if (!r || !r.id) continue;
      if ((r.completesAt || 0) > now) continue;

      ops.chunk(worldId, chunkKey, `${tileKey}.structure.research.${r.id}`, true);
      ops.chunk(worldId, chunkKey, `${tileKey}.structure.researchInProgress`, null);

      const [x, y] = tileKey.split(',').map(Number);
      ops.chat(worldId, {
        location: { x, y },
        text: `Research complete: ${r.name || r.id}.`,
        timestamp: now, type: 'system', category: 'player'
      });
      if (r.startedBy) {
        ops.player(r.startedBy, null, `notifications.research_${now}_${r.id}`, {
          type: 'research_complete', worldId, researchId: r.id, location: { x, y }, timestamp: now
        });
      }
      processed++;
    }
  }

  if (processed) await ops.flush(db);
  return { processed };
}

export default processResearch;
