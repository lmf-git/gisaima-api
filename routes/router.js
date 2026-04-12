import { handleGuestLogin, handleRegister, handleLogin, handleMe,
         getAuth, apiError } from '../core/auth.js';
import { getWorlds, getWorld, getChunk, getWorldChat } from './worlds.js';
import { getPlayerWorlds, getPlayerWorldState }         from './players.js';
import { postChat }                                     from './chat.js';

import attack                from './actions/attack.js';
import buildStructure        from './actions/buildStructure.js';
import cancelCrafting        from './actions/cancelCrafting.js';
import cancelGathering       from './actions/cancelGathering.js';
import cancelMovement        from './actions/cancelMovement.js';
import cancelRecruitment     from './actions/cancelRecruitment.js';
import demobiliseUnits       from './actions/demobiliseUnits.js';
import flee                  from './actions/flee.js';
import joinBattle            from './actions/joinBattle.js';
import joinWorld             from './actions/joinWorld.js';
import loadGroup             from './actions/loadGroup.js';
import mobiliseUnits         from './actions/mobiliseUnits.js';
import moveGroup             from './actions/moveGroup.js';
import recruitUnits          from './actions/recruitUnits.js';
import saveAchievement       from './actions/saveAchievement.js';
import spawnPlayer           from './actions/spawnPlayer.js';
import startBuildingUpgrade  from './actions/startBuildingUpgrade.js';
import startCrafting         from './actions/startCrafting.js';
import startGathering        from './actions/startGathering.js';
import startStructureUpgrade from './actions/startStructureUpgrade.js';
import unloadGroup           from './actions/unloadGroup.js';

export async function route(db, req, body) {
  const { method } = req;
  const p = new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '') || '/';
  const [, s1, s2, s3, s4] = p.split('/');

  // ── Healthcheck ───────────────────────────────────────────────────────────
  if (method === 'GET' && p === '/') return { ok: true };

  // ── Auth ──────────────────────────────────────────────────────────────────
  if (method === 'POST' && p === '/auth/guest')    return handleGuestLogin(db, req, body);
  if (method === 'POST' && p === '/auth/register') return handleRegister(db, req, body);
  if (method === 'POST' && p === '/auth/login')    return handleLogin(db, req, body);
  if (method === 'GET'  && p === '/auth/me')       return handleMe(db, req);

  // ── Worlds ────────────────────────────────────────────────────────────────
  if (method === 'GET' && p === '/worlds')                           return getWorlds(db);
  if (method === 'GET' && s1 === 'worlds' && s2 && !s3)             return getWorld(db, s2);
  if (method === 'GET' && s1 === 'worlds' && s3 === 'chunks' && s4) return getChunk(db, s2, decodeURIComponent(s4));
  if (method === 'GET' && s1 === 'worlds' && s3 === 'chat')         return getWorldChat(db, s2);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'chat') {
    const auth = getAuth(req);
    if (!auth) throw apiError(401, 'not authenticated');
    return postChat(db, auth, s2, body);
  }

  // ── Players ───────────────────────────────────────────────────────────────
  if (method === 'GET' && s1 === 'players' && s3 === 'worlds' && !s4) {
    const auth = getAuth(req);
    if (!auth) throw apiError(401, 'not authenticated');
    return getPlayerWorlds(db, auth, s2);
  }
  if (method === 'GET' && s1 === 'players' && s3 === 'worlds' && s4) {
    const auth = getAuth(req);
    if (!auth) throw apiError(401, 'not authenticated');
    return getPlayerWorldState(db, auth, s2, s4);
  }

  // ── Actions ───────────────────────────────────────────────────────────────
  if (method === 'POST' && s1 === 'actions') {
    const auth = getAuth(req);
    if (!auth) throw apiError(401, 'not authenticated');
    const ctx = { uid: auth.uid, isGuest: auth.isGuest, data: body, db };

    if (s2 === 'attack')                return attack(ctx);
    if (s2 === 'buildStructure')        return buildStructure(ctx);
    if (s2 === 'cancelCrafting')        return cancelCrafting(ctx);
    if (s2 === 'cancelGathering')       return cancelGathering(ctx);
    if (s2 === 'cancelMovement')        return cancelMovement(ctx);
    if (s2 === 'cancelRecruitment')     return cancelRecruitment(ctx);
    if (s2 === 'demobiliseUnits')       return demobiliseUnits(ctx);
    if (s2 === 'flee')                  return flee(ctx);
    if (s2 === 'joinBattle')            return joinBattle(ctx);
    if (s2 === 'joinWorld')             return joinWorld(ctx);
    if (s2 === 'loadGroup')             return loadGroup(ctx);
    if (s2 === 'mobiliseUnits')         return mobiliseUnits(ctx);
    if (s2 === 'moveGroup')             return moveGroup(ctx);
    if (s2 === 'recruitUnits')          return recruitUnits(ctx);
    if (s2 === 'saveAchievement')       return saveAchievement(ctx);
    if (s2 === 'spawnPlayer')           return spawnPlayer(ctx);
    if (s2 === 'startBuildingUpgrade')  return startBuildingUpgrade(ctx);
    if (s2 === 'startCrafting')         return startCrafting(ctx);
    if (s2 === 'startGathering')        return startGathering(ctx);
    if (s2 === 'startStructureUpgrade') return startStructureUpgrade(ctx);
    if (s2 === 'unloadGroup')           return unloadGroup(ctx);

    throw apiError(404, `unknown action: ${s2}`);
  }

  throw apiError(404, 'not found');
}
