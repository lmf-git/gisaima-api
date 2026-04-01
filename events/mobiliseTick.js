/**
 * Mobilization tick processing for Gisaima
 * Handles completing group mobilization during tick cycles
 */

export function processMobilizations(worldId, updates, groups, chunkKey, tileKey, now) {
  let mobilizationsProcessed = 0;

  for (const [groupId, group] of Object.entries(groups)) {
    if (group.status !== 'mobilizing') continue;

    const groupPath = `worlds/${worldId}/chunks/${chunkKey}/${tileKey}/groups/${groupId}`;
    updates[`${groupPath}/status`] = 'idle';

    const chatMessageText = createMobilizationMessage(group, tileKey);
    const chatMessageKey = `chat_${now}_${Math.floor(Math.random() * 1000)}`;
    updates[`worlds/${worldId}/chat/${chatMessageKey}`] = {
      text: chatMessageText,
      type: 'event',
      timestamp: now,
      userId: group.owner || 'system',
      userName: group.name || 'System',
      location: {
        x: parseInt(tileKey.split(',')[0]),
        y: parseInt(tileKey.split(',')[1]),
        timestamp: now
      }
    };

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
