import * as spawns from '../db/spawns.js';

export const VISIBILITY_TIERS = [
  { tier: 'something',   maxDistance: 8, desc: 'Scouts see that something is there.' },
  { tier: 'what',        maxDistance: 5, desc: 'Scouts see what type it is.' },
  { tier: 'where-going', maxDistance: 3, desc: 'Scouts see direction of travel.' },
  { tier: 'identity',    maxDistance: 1, desc: 'Identity & loadout exposed.' }
];

export async function getScouting(db, worldId) {
  const list = await spawns.listFor(db, worldId);
  return { tiers: VISIBILITY_TIERS, spawns: list };
}
