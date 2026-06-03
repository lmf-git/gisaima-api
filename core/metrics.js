/**
 * Lightweight in-process metrics for the tick and runtime. No external store —
 * a single dyno serves everything, so a module singleton is the whole picture.
 * Surfaced read-only at GET /metrics (see routes/metrics.js).
 */

const _startedAt = Date.now();

const M0_STORAGE_LIMIT_BYTES = 512 * 1024 * 1024; // free-tier Atlas cap
const _mb = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;

/**
 * Live DB storage figures vs the M0 512MB cap — the metric most worth watching.
 * Defensive: returns { error } rather than throwing if the cluster hiccups, so
 * neither /metrics nor the tick can be taken down by a stats() failure.
 */
export async function storageReport(db) {
  try {
    const s = await db.stats();
    return {
      dataMB:    _mb(s.dataSize),
      storageMB: _mb(s.storageSize),
      indexMB:   _mb(s.indexSize),
      capMB:     _mb(M0_STORAGE_LIMIT_BYTES),
      usedPct:   Math.round((s.storageSize / M0_STORAGE_LIMIT_BYTES) * 1000) / 10,
    };
  } catch (err) {
    return { error: err.message };
  }
}

const _run = {
  count:        0,     // total tick runs since boot
  lastAt:       null,  // ms epoch of last run start
  lastTotalMs:  null,  // wall time of the last full runTick (all worlds)
  slowRuns:     0,     // runs whose wall time exceeded the target interval
};

// Per-world rolling snapshot of the most recent tick.
const _worlds = new Map(); // worldId → { lastMs, activeChunks, deleted, pruned, at }

export function recordWorldTick(worldId, { durationMs, activeChunks, deleted = 0, pruned = 0 }) {
  _worlds.set(worldId, {
    lastMs:       durationMs,
    activeChunks,
    deleted,
    pruned,
    at:           Date.now(),
  });
}

export function recordRun({ totalMs, slow }) {
  _run.count++;
  _run.lastAt      = Date.now();
  _run.lastTotalMs = totalMs;
  if (slow) _run.slowRuns++;
}

/** Plain snapshot of the in-process counters (no I/O). */
export function snapshot() {
  return {
    uptimeSec: Math.round((Date.now() - _startedAt) / 1000),
    run:       { ..._run },
    worlds:    Object.fromEntries(_worlds),
  };
}
