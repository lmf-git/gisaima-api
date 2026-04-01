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

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME   = process.env.DB_NAME   || 'gisaima';
const backupPath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(new URL('.', import.meta.url).pathname, '../../web/backup.json');

async function seed() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);

  const raw    = readFileSync(backupPath, 'utf8');
  const backup = JSON.parse(raw);

  console.log(`Seeding from ${backupPath} into ${DB_NAME}…`);

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
