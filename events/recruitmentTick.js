/**
 * Recruitment tick processing for Gisaima
 * Handles completing unit recruitment during tick cycles (per-tile helper)
 */

import UNITS from 'gisaima-shared/definitions/UNITS.js';

export function processRecruitment(worldId, updates, chunkKey, tileKey, tile, now) {
  if (!tile?.structure?.recruitmentQueue) return 0;

  let processed      = 0;
  const structurePath = `worlds/${worldId}/chunks/${chunkKey}/${tileKey}/structure`;
  const structure     = tile.structure;

  for (const [recruitmentId, recruitment] of Object.entries(structure.recruitmentQueue)) {
    if (!recruitment.completesAt || recruitment.completesAt > now) continue;

    const unitId         = recruitment.unitId;
    const unitDefinition = UNITS[unitId] || {};
    const unitName       = recruitment.unitName || unitDefinition.name || 'Unknown Unit';
    const quantity       = recruitment.quantity || 1;
    const owner          = recruitment.owner;
    const race           = recruitment.race || unitDefinition.race || structure.race || 'neutral';
    const type           = recruitment.type || unitDefinition.type;
    const power          = unitDefinition.power || recruitment.power || 1;
    const icon           = unitDefinition.icon || recruitment.icon || 'sword';
    const newUnitId      = `unit_${now}_${recruitmentId}`;

    // Remove from queue
    updates[`${structurePath}/recruitmentQueue/${recruitmentId}`] = null;

    if (!structure.units) updates[`${structurePath}/units`] = {};

    const unitGroup = {
      id: newUnitId,
      name: `${unitName} Group`,
      unitId,
      type,
      race,
      quantity,
      power,
      icon,
      owner,
      createdAt: now,
      category:    unitDefinition.category    || 'player',
      description: unitDefinition.description || `Group of ${unitName}`
    };

    if (Array.isArray(structure.units)) {
      updates[`${structurePath}/units/${structure.units.length}`] = unitGroup;
    } else {
      updates[`${structurePath}/units/${unitId}`] = unitGroup;
    }

    if (owner) {
      updates[`players/${owner}/worlds/${worldId}/structures/${structure.id}/units/${unitId}`] = {
        id: unitId, name: `${unitName} Group`, quantity
      };
    }

    const chatId = `recruit_complete_${now}_${Math.floor(Math.random() * 1000)}`;
    updates[`worlds/${worldId}/chat/${chatId}`] = {
      text: `${quantity} ${unitName} units completed recruitment at (${tileKey.replace(',', ', ')})`,
      type: 'event',
      timestamp: now,
      location: {
        x: parseInt(tileKey.split(',')[0]),
        y: parseInt(tileKey.split(',')[1]),
        timestamp: now
      }
    };

    processed++;
  }

  return processed;
}
