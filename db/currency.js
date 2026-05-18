/**
 * Player-issued currency. Each structure may declare one official currency.
 * Schema (`currencies`):
 *   _id, worldId, structureKey ('x,y' | null), name, symbol,
 *   exchange (units of currency per 1 gold), issuerUid, createdAt
 *
 * Used by trade.js to convert offer prices when both sides agree to a currency.
 */
import { ObjectId } from 'mongodb';

export async function listFor(db, worldId) {
  return db.collection('currencies').find({ worldId }).limit(200).toArray();
}

export async function getByStructure(db, worldId, structureKey) {
  if (!structureKey) return null;
  return db.collection('currencies').findOne({ worldId, structureKey });
}

export async function create(db, { worldId, issuerUid, structureKey, name, symbol, exchange }) {
  if (!name || !symbol) throw new Error('name and symbol required');
  const insert = {
    worldId,
    structureKey: structureKey || null,
    name,
    symbol,
    exchange: Math.max(0.01, Number(exchange) || 1.0),
    issuerUid,
    createdAt: new Date()
  };
  if (structureKey) {
    await db.collection('currencies').deleteOne({ worldId, structureKey });
  }
  const r = await db.collection('currencies').insertOne(insert);
  return { ...insert, _id: r.insertedId };
}

export async function setOfficial(db, worldId, structureKey, currencyId) {
  const _id = new ObjectId(currencyId);
  const c = await db.collection('currencies').findOne({ _id });
  if (!c) throw new Error('currency not found');
  await db.collection('currencies').updateMany(
    { worldId, structureKey },
    { $set: { structureKey: null } }
  );
  await db.collection('currencies').updateOne(
    { _id },
    { $set: { structureKey } }
  );
  return { ok: true };
}

export function convertGoldTo(currency, gold) {
  if (!currency) return gold;
  return Math.round(gold * (currency.exchange || 1));
}
