/**
 * Recruitment tick processing for Gisaima
 * Handles completing unit recruitment during tick cycles (per-tile helper)
 */

import UNITS from 'gisaima-shared/definitions/UNITS.js';

export function processRecruitment(worldId, ops, chunkKey, tileKey, tile, now) {
  if (!tile?.structure?.recruitmentQueue) return 0;

  let processed = 0;
  const structure = tile.structure;

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

    ops.chunk(worldId, chunkKey, `${tileKey}.structure.recruitmentQueue.${recruitmentId}`, null);

    if (!structure.units) ops.chunk(worldId, chunkKey, `${tileKey}.structure.units`, {});

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
      ops.chunk(worldId, chunkKey, `${tileKey}.structure.units.${structure.units.length}`, unitGroup);
    } else {
      ops.chunk(worldId, chunkKey, `${tileKey}.structure.units.${unitId}`, unitGroup);
    }

    if (owner) {
      ops.player(owner, worldId, `structures.${structure.id}.units.${unitId}`, {
        id: unitId, name: `${unitName} Group`, quantity
      });
    }

    const [x, y] = tileKey.split(',').map(Number);
    ops.chat(worldId, {
      text: `${quantity} ${unitName} units completed recruitment at (${x}, ${y})`,
      type: 'event',
      timestamp: now,
      location: { x, y, timestamp: now }
    });

    processed++;
  }

  return processed;
}
