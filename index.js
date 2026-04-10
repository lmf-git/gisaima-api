import 'dotenv/config';
import { createServer } from 'http';
import { connect, getDb } from './db/connection.js';
import { attachWss } from './core/ws.js';
import { startTick } from './core/tick.js';
import { route } from './routes/router.js';
import { readBody } from './lib/readBody.js';

const PORT = Number(process.env.PORT) || 3001;

const server = createServer(async (req, res) => {
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin',  req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
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

async function main() {
  await connect();
  attachWss(server);
  startTick();
  server.listen(PORT, () => console.log(`API listening on :${PORT}`));
}

main().catch(err => { console.error(err); process.exit(1); });
