// The Chronicle — the world's long memory. Only record-breaking events are
// inscribed: a battle larger than any before it, the capture of the richest or
// highest-ranked stronghold yet, the fall of the most renowned player. Each
// world keeps a single `chronicle_records` doc tracking the standing maxima, and
// a `chronicle` collection of the entries themselves.
//
// Per-world ticks run sequentially, so the read-compare-write below is safe
// without transactions.

const MAX_ENTRIES_RETURNED = 100;

// Raise a record if `value` beats the stored maximum for `field`. Returns true
// when a new record was set (including the very first time the field is seen).
export async function bumpRecord(db, worldId, field, value) {
  if (!Number.isFinite(value) || value <= 0) return false;
  const existing = await db.collection('chronicle_records')
    .findOne({ worldId }, { projection: { [field]: 1 } });
  const current = existing?.[field] ?? 0;
  if (value <= current) return false;
  await db.collection('chronicle_records').updateOne(
    { worldId },
    { $set: { [field]: value }, $setOnInsert: { worldId } },
    { upsert: true }
  );
  return true;
}

export async function addEntry(db, worldId, entry) {
  await db.collection('chronicle').insertOne({
    worldId,
    timestamp: Date.now(),
    ...entry,
  });
}

export async function getChronicle(db, worldId, limit = MAX_ENTRIES_RETURNED) {
  const rows = await db.collection('chronicle')
    .find({ worldId })
    .sort({ timestamp: -1 })
    .limit(Math.min(limit, MAX_ENTRIES_RETURNED))
    .toArray();
  return rows.map(r => ({ ...r, _id: r._id?.toString() }));
}

// ── Affiliation lookup ──────────────────────────────────────────────────────
// Resolve the house and tribe a player belongs to, for richer entries. One
// player-doc read plus an optional tribe scan; only called for record events,
// which are rare.
async function affiliation(db, worldId, uid) {
  if (!uid) return { houseName: null, tribeName: null };
  const [player, tribe] = await Promise.all([
    db.collection('players').findOne(
      { _id: uid },
      { projection: { [`worlds.${worldId}.houseName`]: 1 } }
    ),
    db.collection('tribes').findOne(
      { worldId, 'members.uid': uid },
      { projection: { name: 1, tag: 1 } }
    ),
  ]);
  return {
    houseName: player?.worlds?.[worldId]?.houseName || null,
    tribeName: tribe ? (tribe.tag ? `${tribe.name} [${tribe.tag}]` : tribe.name) : null,
  };
}

function affixLine(label, { houseName, tribeName }) {
  const parts = [];
  if (houseName) parts.push(`House ${houseName}`);
  if (tribeName) parts.push(tribeName);
  return parts.length ? ` ${label} ${parts.join(', ')}.` : '';
}

// ── Event helpers ───────────────────────────────────────────────────────────

// A stronghold changed hands. Chronicled when its rank-points or its stored
// wealth exceed any previously-captured stronghold's.
export async function chronicleCapture(db, worldId, {
  structureName, points, wealth, location, capturerUid, capturerName, prevOwnerName, groupNames = [],
}) {
  const byPoints = await bumpRecord(db, worldId, 'maxCaptureStructurePoints', points);
  const byWealth = await bumpRecord(db, worldId, 'maxCaptureStructureWealth', wealth);
  if (!byPoints && !byWealth) return;

  const aff = await affiliation(db, worldId, capturerUid);
  const reason = byPoints
    ? `the mightiest stronghold yet to fall (${points} points)`
    : `the richest prize yet taken (${wealth.toLocaleString()} gold)`;

  await addEntry(db, worldId, {
    kind: 'capture',
    title: `${capturerName || 'A warlord'} seizes ${structureName}`,
    body: `${structureName} — ${reason} — was wrested from ${prevOwnerName || 'its keepers'} by ${capturerName || 'an unknown force'}.`
      + affixLine('Banners of', aff)
      + (groupNames.length ? ` Forces: ${groupNames.join(', ')}.` : ''),
    location,
    meta: { points, wealth, capturerUid, capturerName, prevOwnerName },
  });
}

// A player has fallen. Chronicled when the victim's standing points exceed any
// previously-chronicled fallen player's.
export async function chroniclePlayerKill(db, worldId, {
  victimName, victimUid, victimPoints, killerName, killerUid, location,
}) {
  if (!(await bumpRecord(db, worldId, 'maxKillVictimPoints', victimPoints))) return;

  const [vAff, kAff] = await Promise.all([
    affiliation(db, worldId, victimUid),
    affiliation(db, worldId, killerUid),
  ]);

  await addEntry(db, worldId, {
    kind: 'kill',
    title: `${victimName || 'A champion'} is slain`,
    body: `${victimName || 'A renowned figure'} (${victimPoints} points), the greatest to fall thus far, was struck down by ${killerName || 'an unknown hand'}.`
      + affixLine('The fallen of', vAff)
      + affixLine('The victor of', kAff),
    location,
    meta: { victimUid, victimName, victimPoints, killerUid, killerName },
  });
}

// A battle has been joined. Chronicled when more units fought than in any
// previous battle in this world.
export async function chronicleBattle(db, worldId, {
  units, side1Names = [], side2Names = [], location,
}) {
  if (!(await bumpRecord(db, worldId, 'maxBattleUnits', units))) return;

  await addEntry(db, worldId, {
    kind: 'battle',
    title: `The largest battle yet — ${units} combatants`,
    body: `${units} units clashed, the greatest host this realm has seen.`
      + (side1Names.length ? ` Attackers: ${side1Names.join(', ')}.` : '')
      + (side2Names.length ? ` Defenders: ${side2Names.join(', ')}.` : ''),
    location,
    meta: { units },
  });
}
