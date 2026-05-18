/**
 * Spawn structures and their exclusion zones.
 * Each spawn entry records cardinal direction or a premium tag and a radius
 * inside which kills and building actions are blocked.
 *
 * Schema (`spawns`):
 *   worldId, x, y, kind: 'cardinal'|'premium'|'player',
 *   ownerUid?, radius, name, createdAt
 *
 * Helper `isInsideExclusion` is called by:
 *   - battleTick (kill inside spawn → morality penalty)
 *   - buildStructure action (block building inside another spawn's zone)
 *   - movement (informational; movement is allowed but actions are restricted)
 */
const DEFAULT_RADIUS = 5;

export async function listFor(db, worldId) {
  return db.collection('spawns').find({ worldId }).toArray();
}

export async function isInsideExclusion(db, worldId, x, y, exemptUid = null) {
  const spawns = await listFor(db, worldId);
  for (const s of spawns) {
    if (exemptUid && s.ownerUid === exemptUid) continue;
    const dx = x - (s.x ?? 0);
    const dy = y - (s.y ?? 0);
    if (Math.hypot(dx, dy) <= (s.radius ?? DEFAULT_RADIUS)) return s;
  }
  return null;
}

export async function add(db, { worldId, x, y, kind = 'cardinal', ownerUid = null, radius = DEFAULT_RADIUS, name = null }) {
  const doc = {
    worldId, x, y, kind, ownerUid, radius, name: name || `${kind} spawn`, createdAt: new Date()
  };
  await db.collection('spawns').insertOne(doc);
  return doc;
}
