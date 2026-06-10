/**
 * Captives — players taken prisoner in battle instead of being slain.
 *
 * battleTick takes a fallen player captive when they were defeated by another
 * player and the realm does not brand them a villain (villains get the sword).
 * The captor then negotiates their fate through the existing ransom flow:
 * an accepted ransom releases the captive, a default executes them, and a
 * rejected offer leaves them held until the captor relents (release route).
 *
 * Schema (`captives`):
 *   _id, worldId, captiveUid, captiveLifeId?, captiveName?, captorUid,
 *   status: 'held' | 'released' | 'executed', capturedAt, settledAt?,
 *   location?: { x, y }
 */

export async function createCaptive(db, { worldId, captiveUid, captiveLifeId = null, captiveName = null, captorUid, location = null }) {
  const doc = {
    worldId,
    captiveUid,
    captiveLifeId,
    captiveName,
    captorUid,
    status: 'held',
    capturedAt: new Date(),
    location,
  };
  const r = await db.collection('captives').insertOne(doc);
  return { ...doc, _id: r.insertedId };
}

/** All active captivities a user is party to (as captor or captive). */
export async function listFor(db, worldId, uid) {
  return db.collection('captives')
    .find({ worldId, status: 'held', $or: [{ captiveUid: uid }, { captorUid: uid }] })
    .sort({ capturedAt: -1 })
    .toArray();
}

/** The active captivity holding this captive, if any. */
export async function findHeld(db, worldId, captiveUid) {
  return db.collection('captives').findOne({ worldId, captiveUid, status: 'held' });
}

/** Settle a captivity — `status` is 'released' or 'executed'. */
export async function settleCaptivity(db, worldId, captiveUid, status, reason = null) {
  const r = await db.collection('captives').updateOne(
    { worldId, captiveUid, status: 'held' },
    { $set: { status, settledAt: new Date(), ...(reason ? { reason } : {}) } }
  );
  return r.modifiedCount > 0;
}
