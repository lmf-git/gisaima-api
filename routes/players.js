import { apiError } from '../core/auth.js';
import { getPlayerJoinedWorlds, getPlayerWorldData } from '../db/players.js';
import { getPlayerHouse, getPlayerPendingRequest } from '../db/houses.js';
import ImageProvider from '../lib/imageProvider.js';

const MOTTO_MAX = 120;

export async function getPlayerWorlds(db, auth, userId) {
  if (auth.uid !== userId) throw apiError(403, 'forbidden');
  return getPlayerJoinedWorlds(db, userId);
}

export async function getPlayerWorldState(db, auth, userId, worldId) {
  if (auth.uid !== userId) throw apiError(403, 'forbidden');
  const data = await getPlayerWorldData(db, userId, worldId);
  if (!data) throw apiError(404, 'player world data not found');

  // Resolve the player's house from the house entity (the source of truth).
  // Membership is optional, so all of these may be null/empty.
  const house = await getPlayerHouse(db, worldId, userId);
  const isFounder = !!house && house.founderId === userId;

  // A player may have an outstanding request awaiting approval (they keep any
  // current house until a founder approves them, at which point they move).
  const pendingRequest = await getPlayerPendingRequest(db, worldId, userId);

  return {
    ...data,
    houseId:        house ? house._id.toString() : null,
    houseName:      house ? house.name : null,
    isHouseFounder: isFounder,
    // The founder sees who is knocking; everyone else gets an empty list.
    houseRequests:  isFounder ? (house.joinRequests || []).map(r => ({
      uid: r.uid, displayName: r.displayName, requestedAt: r.requestedAt,
    })) : [],
    pendingHouseRequest: pendingRequest, // { houseId, houseName } | null
  };
}

/**
 * Public, read-only profile for another player in a world. Returns only the
 * fields safe to show anyone (identity, race, motto, avatar, skills, house) —
 * no account/private data. Any signed-in player may view it.
 */
export async function getPublicProfile(db, auth, worldId, targetUid) {
  const data = await getPlayerWorldData(db, targetUid, worldId);
  if (!data) throw apiError(404, 'player not found');

  const house = await getPlayerHouse(db, worldId, targetUid);

  return {
    uid: targetUid,
    displayName: data.displayName || '',
    race: data.race || null,
    sex: data.sex || null,
    motto: data.motto || '',
    avatar: data.avatar || null,
    skills: data.skills || {},
    joined: data.joined || null,
    alive: data.alive ?? null,
    houseName: house ? house.name : null,
  };
}

/**
 * Update the caller's profile for a world — personal motto and/or avatar.
 * The avatar arrives as a base64 data-URI in the JSON body (no multipart
 * parsing); it is uploaded to Cloudinary and only the resulting URL is stored.
 */
export async function postProfile(db, auth, worldId, body) {
  const set = {};

  if (typeof body?.motto === 'string') {
    set[`worlds.${worldId}.motto`] = body.motto.trim().slice(0, MOTTO_MAX);
  }

  if (typeof body?.avatar === 'string' && body.avatar.startsWith('data:image/')) {
    if (!ImageProvider.enabled) throw apiError(503, 'image uploads are not configured');
    let url;
    try {
      url = await ImageProvider.upload(body.avatar, { folder: `gisaima/${worldId}/avatars` });
    } catch (e) {
      throw apiError(502, `avatar upload failed: ${e?.message || 'unknown error'}`);
    }
    set[`worlds.${worldId}.avatar`] = url;
  } else if (body?.avatar === null) {
    // Explicit null clears the avatar.
    set[`worlds.${worldId}.avatar`] = null;
  }

  if (!Object.keys(set).length) throw apiError(400, 'nothing to update');

  await db.collection('players').updateOne({ _id: auth.uid }, { $set: set });
  return {
    ok: true,
    motto: set[`worlds.${worldId}.motto`],
    avatar: set[`worlds.${worldId}.avatar`],
  };
}

/** Toggle ranking privacy — anonymises the caller on public leaderboards. */
export async function postRankingPrivacy(db, auth, worldId, body) {
  const hide = body?.hide === true;
  await db.collection('players').updateOne(
    { _id: auth.uid },
    { $set: { [`worlds.${worldId}.hideFromRankings`]: hide } }
  );
  return { ok: true, hideFromRankings: hide };
}
