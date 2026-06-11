/**
 * Gathering skills — Mining, Woodcutting, Fishing.
 *
 * Skill progress is stored per world on the player doc at
 *   players.worlds.<worldId>.skills.<skill>.xp
 * and the level is derived from xp (every 100 xp → +1 level, starting at 1).
 * Gathering the matching resource for a biome trains that biome's skill, and a
 * higher skill level yields a larger haul there (see gatheringTick).
 */

export const GATHERING_SKILLS = ['mining', 'woodcutting', 'fishing'];

export const XP_PER_GATHER = 12;

// Level from accumulated xp. Level 1 at 0 xp, +1 every 100 xp.
export function skillLevel(xp) {
  return Math.floor((Number(xp) || 0) / 100) + 1;
}

// Which gathering skill a biome trains, or null if none in particular.
export function skillForBiome(biome) {
  const b = (biome || '').toLowerCase();
  if (/mountain|peak|hill|cavern|cave|volcan|lava|magma/.test(b)) return 'mining';
  if (/forest|wood|grove|jungle|taiga|tree/.test(b))             return 'woodcutting';
  if (/water|lake|river|ocean|sea|coast|marsh|swamp|bog|reef/.test(b)) return 'fishing';
  return null;
}

// Yield multiplier granted by a gatherer's skill level for the biome it trains:
// +6% per level above 1, capped at +120% (level 21+).
export function skillYieldMultiplier(level) {
  const l = Math.max(1, Number(level) || 1);
  return 1 + Math.min(1.2, (l - 1) * 0.06);
}
