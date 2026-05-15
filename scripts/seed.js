/**
 * Seed MongoDB from the Firebase backup (web/backup.json).
 *
 * Usage:
 *   node api/scripts/seed.js [path/to/backup.json]
 *
 * The backup format is:
 *   {
 *     available: { worldId: true },
 *     players: { userId: { worlds: { worldId: { ... } } } },
 *     worlds: { worldId: { info: {...}, chunks: { chunkKey: { tileKey: tileData } } } }
 *   }
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/gisaima';
const backupPath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(new URL('.', import.meta.url).pathname, '../../web/backup.json');

async function waitForMongo(uri, retries = 20, delayMs = 1500) {
  for (let i = 1; i <= retries; i++) {
    try {
      const c = new MongoClient(uri);
      await c.connect();
      await c.db().command({ ping: 1 });
      await c.close();
      return;
    } catch {
      console.log(`Waiting for MongoDB… (${i}/${retries})`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error('MongoDB did not become ready in time');
}

async function seed() {
  await waitForMongo(MONGO_URI);
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(); // Uses the DB name from the URI

  const raw    = readFileSync(backupPath, 'utf8');
  const backup = JSON.parse(raw);

  console.log(`Seeding from ${backupPath} into ${db.databaseName}…`);

  // -------------------------------------------------------------------------
  // Worlds + Chunks
  // -------------------------------------------------------------------------
  const worlds = backup.worlds || {};
  for (const [worldId, worldData] of Object.entries(worlds)) {
    const info   = worldData.info || {};
    const chunks = worldData.chunks || {};

    await db.collection('worlds').updateOne(
      { _id: worldId },
      { $setOnInsert: { _id: worldId, info } },
      { upsert: true }
    );
    console.log(`  World "${worldId}" — ${Object.keys(chunks).length} chunks`);

    for (const [chunkKey, tiles] of Object.entries(chunks)) {
      await db.collection('chunks').updateOne(
        { worldId, chunkKey },
        { $setOnInsert: { worldId, chunkKey, tiles: tiles || {} } },
        { upsert: true }
      );
    }
  }

  // -------------------------------------------------------------------------
  // Players
  // -------------------------------------------------------------------------
  const players = backup.players || {};
  for (const [userId, playerData] of Object.entries(players)) {
    await db.collection('players').updateOne(
      { _id: userId },
      { $setOnInsert: { _id: userId, worlds: playerData.worlds || {} } },
      { upsert: true }
    );
  }
  console.log(`  Players: ${Object.keys(players).length}`);

  await client.close();
  console.log('Seed complete.');
}

seed().catch(err => { console.error(err); process.exit(1); });
