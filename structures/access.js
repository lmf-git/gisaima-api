/**
 * Per-structure access control.
 *
 * Owned structures carry `structure.access = { build, recruit, deposit }`, each
 * an access tier. Race spawns are communal and instead gate on race.
 *
 * Tiers:
 *   'owner'  — only the owner (default)
 *   'friends'— owner's friends (see db/friends.js)
 *   'tribe'  — members of the owner's tribe
 *   'public' — anyone
 */
import { getPlayerTribe } from '../db/tribes.js';
import { areFriends } from '../db/friends.js';
import { getPlayerWorldData } from '../db/players.js';

export const ACCESS_ACTIONS = ['build', 'recruit', 'deposit'];
export const ACCESS_TIERS = ['owner', 'friends', 'tribe', 'public'];
export const DEFAULT_ACCESS = { build: 'owner', recruit: 'owner', deposit: 'owner' };

export function isValidTier(t) {
  return ACCESS_TIERS.includes(t);
}

/**
 * @param {object} args
 * @param {import('mongodb').Db} args.db
 * @param {string} args.worldId
 * @param {object} args.structure - the tile's structure
 * @param {string} args.uid - the acting player
 * @param {'build'|'recruit'|'deposit'} args.action
 * @returns {Promise<boolean>}
 */
export async function canUse({ db, worldId, structure, uid, action }) {
  if (!structure || !uid) return false;

  // Owner can always act.
  if (structure.owner && structure.owner === uid) return true;

  // Communal race spawns: gate on matching race rather than ownership.
  if (structure.type === 'spawn') {
    if (!structure.race) return true; // un-raced spawn → open
    const pd = await getPlayerWorldData(db, uid, worldId);
    return (pd?.race || null) === structure.race;
  }

  // Non-spawn, non-owner: resolve the configured tier for this action.
  const tier = structure.access?.[action] ?? DEFAULT_ACCESS[action] ?? 'owner';
  switch (tier) {
    case 'public':
      return true;
    case 'tribe': {
      if (!structure.owner) return false;
      const [mine, theirs] = await Promise.all([
        getPlayerTribe(db, worldId, uid),
        getPlayerTribe(db, worldId, structure.owner),
      ]);
      return !!(mine && theirs && String(mine._id) === String(theirs._id));
    }
    case 'friends':
      if (!structure.owner) return false;
      return areFriends(db, worldId, structure.owner, uid);
    case 'owner':
    default:
      return false;
  }
}

export default canUse;
