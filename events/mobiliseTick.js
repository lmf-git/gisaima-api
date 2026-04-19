/**
 * Mobilization tick processing for Gisaima
 * Handles completing group mobilization during tick cycles
 */

export function processMobilizations(worldId, ops, groups, chunkKey, tileKey, now, lastTickTime = 0) {
  let mobilizationsProcessed = 0;

  for (const [groupId, group] of Object.entries(groups)) {
    if (group.status !== 'mobilizing') continue;
    // Skip groups created after the previous tick — they'll complete on the next tick
    if (group.mobilizedAt && lastTickTime && group.mobilizedAt >= lastTickTime) continue;

    ops.chunk(worldId, chunkKey, `${tileKey}.groups.${groupId}.status`, 'idle');

    const [x, y] = tileKey.split(',').map(Number);
    ops.chat(worldId, {
      text: createMobilizationMessage(group, tileKey),
      type: 'event',
      timestamp: now,
      userId: group.owner || 'system',
      userName: group.name || 'System',
      location: { x, y, timestamp: now }
    });

    mobilizationsProcessed++;
    console.log(`Group ${groupId} completed mobilization at ${tileKey} in chunk ${chunkKey}`);
  }

  return mobilizationsProcessed;
}

function createMobilizationMessage(group, tileKey) {
  const groupName   = group.name || 'Unnamed force';
  const groupSize   = group.units?.length || 'unknown size';
  const groupRace   = group.race ? `${group.race}` : '';
  const location    = tileKey.replace(',', ', ');
  let message       = '';

  if (groupSize === 1) {
    message = `A lone ${groupRace} warrior has mobilized`;
  } else if (groupSize <= 3) {
    message = `A small band of ${groupRace} fighters has mobilized`;
  } else if (groupSize <= 10) {
    message = `A company of ${groupRace} troops has mobilized`;
  } else {
    message = `A large army of ${groupRace} forces has mobilized`;
  }

  return `${message} at (${location}) - "${groupName}"`;
}
