import 'dotenv/config';
import { createServer } from 'http';
import { connect, getDb, close as closeDb } from './db/connection.js';
import { attachWss, closeWss } from './core/ws.js';
import { startTick, stopTick } from './core/tick.js';
import { route } from './routes/router.js';
import { readBody } from './lib/readBody.js';

const PORT = Number(process.env.PORT) || 3001;

// CORS allowlist. Production is served from gisaima.com; local dev runs the
// frontend on some localhost port. Anything else is rejected (we echo the
// specific Origin because credentialed requests can't use a wildcard). Extra
// origins can be added via ALLOWED_ORIGINS (comma-separated) without a deploy.
const ALLOWED_ORIGINS = new Set([
  'https://gisaima.com',
  'https://www.gisaima.com',
  ...(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
]);
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1'; // any dev port
  } catch { return false; }
}

const server = createServer(async (req, res) => {
  const method = req.method;

  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Metrics-Token');
  if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  res.setHeader('Content-Type', 'application/json');

  try {
    const db   = getDb();
    const body = (method === 'POST' || method === 'PUT') ? await readBody(req) : {};
    const result = await route(db, req, body);
    res.writeHead(200);
    res.end(JSON.stringify(result));
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.writeHead(status);
    res.end(JSON.stringify({ error: err.message || 'internal error' }));
  }
});

// Keep idle connections alive longer than Heroku's 55s router timeout so the
// router never reuses a socket Node just closed — a classic source of stray
// 502s. headersTimeout must exceed keepAliveTimeout.
server.keepAliveTimeout = 60_000;
server.headersTimeout   = 65_000;

async function main() {
  await connect();
  attachWss(server);
  startTick();
  server.listen(PORT, () => console.log(`API listening on :${PORT}`));
}

// Heroku cycles the dyno daily and on every deploy: SIGTERM, then SIGKILL after
// ~30s. Drain cleanly so we never die mid-write — stop scheduling ticks and let
// an in-flight one finish, stop accepting new HTTP/WS, then close Mongo.
let _shuttingDown = false;
async function shutdown(signal, exitCode = 0) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[shutdown] ${signal} received — draining`);
  try {
    await stopTick();
    closeWss();
    await new Promise(resolve => server.close(resolve));
    await closeDb();
    console.log('[shutdown] clean');
  } catch (err) {
    console.error('[shutdown] error:', err);
    exitCode = exitCode || 1;
  }
  process.exit(exitCode);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// A single dyno hosts the whole game, so a stray rejection or uncaught throw
// must not silently wedge the process. Log it, then drain and exit non-zero so
// Heroku restarts cleanly — never swallow and continue on corrupt state.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
  shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
  shutdown('uncaughtException', 1);
});

main().catch(err => { console.error(err); process.exit(1); });
