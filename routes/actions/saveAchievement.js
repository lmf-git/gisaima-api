import { apiError } from '../../core/auth.js';

export default async function saveAchievement({ uid, data, db }) {
  const { worldId, achievementId, value = true } = data;
  if (!worldId || !achievementId) throw apiError(400, 'worldId and achievementId required');
  await db.collection('players').updateOne(
    { _id: uid },
    { $set: { [`worlds.${worldId}.achievements.${achievementId}`]: value } },
    { upsert: true }
  );
  return { success: true };
}
