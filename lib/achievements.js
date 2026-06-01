import { broadcastToUser } from '../core/ws.js';

/**
 * Grant an achievement to a player — server-side only.
 *
 * Achievements must never be set from the client (a client could grant itself
 * anything), so every unlock flows through here as a verified side-effect of a
 * real action handler. Idempotent: the DB write and the client-facing
 * `achievement_unlocked` broadcast happen only the first time.
 *
 * @returns {Promise<boolean>} true if newly granted, false if already held.
 */
export async function grantAchievement(db, uid, worldId, achievementId) {
  if (!uid || !worldId || !achievementId) return false;

  const base = `worlds.${worldId}.achievements.${achievementId}`;
  const playerDoc = await db.collection('players').findOne(
    { _id: uid },
    { projection: { [base]: 1 } }
  );
  if (playerDoc?.worlds?.[worldId]?.achievements?.[achievementId] === true) return false;

  await db.collection('players').updateOne(
    { _id: uid },
    { $set: { [base]: true, [`${base}_date`]: Date.now() } },
    { upsert: true }
  );

  broadcastToUser(uid, { type: 'achievement_unlocked', achievementId, worldId });
  return true;
}
