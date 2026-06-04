/**
 * Clear ALL data from MongoDB (opposite of seed.js).
 *
 * Drops every collection in the database — documents and indexes alike,
 * including accounts. Discovered dynamically so new collections never leak into
 * the next seeded world.
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

  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  if (!collections.length) {
    console.log('  (no collections)');
  }
  for (const { name } of collections) {
    await db.collection(name).drop();
    console.log(`  dropped ${name}`);
  }

  await client.close();
  console.log('Clear complete.');
}

clear().catch(err => { console.error(err); process.exit(1); });
