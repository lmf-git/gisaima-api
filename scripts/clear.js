/**
 * Clear all seeded data from MongoDB (opposite of seed.js).
 *
 * Drops the worlds, chunks, and players collections.
 *
 * Usage:
 *   node api/scripts/clear.js
 */

import 'dotenv/config';
import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/gisaima';

async function clear() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db();

  console.log(`Clearing database "${db.databaseName}"…`);

  for (const name of ['worlds', 'chunks', 'players']) {
    const result = await db.collection(name).deleteMany({});
    console.log(`  ${name}: ${result.deletedCount} documents deleted`);
  }

  await client.close();
  console.log('Clear complete.');
}

clear().catch(err => { console.error(err); process.exit(1); });
