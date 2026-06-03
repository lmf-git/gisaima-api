import { snapshot, storageReport } from '../core/metrics.js';
import { getClientCount } from '../core/ws.js';
import { apiError } from '../core/auth.js';

const mb = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;

/**
 * GET /metrics — operational snapshot: tick health, runtime, WS clients, and
 * live DB storage vs the M0 512MB cap (the metric most worth watching).
 *
 * If METRICS_TOKEN is set, callers must pass it via `?token=` or the
 * `x-metrics-token` header; otherwise the endpoint is open (dev convenience).
 */
export async function getMetrics(db, req) {
  const required = process.env.METRICS_TOKEN;
  if (required) {
    const url = new URL(req.url, 'http://localhost');
    const provided = req.headers['x-metrics-token'] || url.searchParams.get('token');
    if (provided !== required) throw apiError(401, 'invalid metrics token');
  }

  const storage = await storageReport(db);

  return {
    ok:        !storage.error,
    ...snapshot(),
    wsClients: getClientCount(),
    process:   { rssMB: mb(process.memoryUsage().rss), node: process.version },
    storage,
  };
}
