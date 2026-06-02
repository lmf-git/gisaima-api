import { handleGuestLogin, handleRegister, handleLogin, handleMe,
         requestEmailLogin, verifyEmailLogin,
         getAuth, apiError } from '../core/auth.js';
import { getWorlds, getWorld, getChunk, getWorldChat } from './worlds.js';
import { getPlayerWorlds, getPlayerWorldState }         from './players.js';
import { postChat }                                     from './chat.js';
import { getReports, postReportRead }                   from './reports.js';
import { getTribes, postCreateTribe, postJoinTribe, postLeaveTribe, getWorldRankings } from './diplomacy.js';
import { getHouses, postCreateHouse, postRequestJoinHouse,
         postCancelJoinRequest, postLeaveHouse,
         postApproveJoinRequest, postRejectJoinRequest } from './houses.js';
import { getBounties, postBounty, postBountyClaim }     from './bounties.js';
import { getFriends, getFriendRequests, postFriendRequest,
         postAcceptRequest, postDeclineRequest, postRemoveFriend } from './friends.js';
import { touchLastSeen }                                from '../db/cleanup.js';
import { getOffers, postOffer, postOfferAction }        from './trade.js';
import { getPolitics, postVote }                        from './politics.js';
import * as morality  from './morality.js';
import * as ransom    from './ransom.js';
import * as trails    from './trails.js';
import * as currency  from './currency.js';
import * as banks     from './banks.js';
import * as cosmetics from './cosmetics.js';
import * as stats     from './stats.js';
import * as lives     from './lives.js';
import { getScouting } from './scouting.js';
import * as itemRoutes from './items.js';

import attack                from './actions/attack.js';
import equipItem             from './actions/equipItem.js';
import buildStructure        from './actions/buildStructure.js';
import addBuilding           from './actions/addBuilding.js';
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
import spawnPlayer           from './actions/spawnPlayer.js';
import startBuildingUpgrade  from './actions/startBuildingUpgrade.js';
import startCrafting         from './actions/startCrafting.js';
import startGathering        from './actions/startGathering.js';
import startStructureUpgrade from './actions/startStructureUpgrade.js';
import unloadGroup           from './actions/unloadGroup.js';
import setStructureTaxes     from './actions/setStructureTaxes.js';
import setStructureAccess    from './actions/setStructureAccess.js';

export async function route(db, req, body) {
  const { method } = req;
  const p = new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '') || '/';
  const [, s1, s2, s3, s4, s5] = p.split('/');

  // ── Healthcheck ───────────────────────────────────────────────────────────
  if (method === 'GET' && p === '/') return { ok: true };

  // ── Auth (public) ─────────────────────────────────────────────────────────
  if (method === 'POST' && p === '/auth/guest')    return handleGuestLogin(db, req, body);
  if (method === 'POST' && p === '/auth/register') return handleRegister(db, req, body);
  if (method === 'POST' && p === '/auth/login')    return handleLogin(db, req, body);
  if (method === 'POST' && p === '/auth/email/request') return requestEmailLogin(db, req, body);
  if (method === 'POST' && p === '/auth/email/verify')  return verifyEmailLogin(db, req, body);
  if (method === 'GET'  && p === '/auth/me')       return handleMe(db, req);

  // ── Public world reads ────────────────────────────────────────────────────
  if (method === 'GET' && p === '/worlds')                           return getWorlds(db);
  if (method === 'GET' && s1 === 'worlds' && s2 && !s3)             return getWorld(db, s2);
  if (method === 'GET' && s1 === 'worlds' && s3 === 'chunks' && s4) {
    const chunkAuth = getAuth(req); // optional — won't throw if absent
    return getChunk(db, s2, decodeURIComponent(s4), chunkAuth?.uid ?? null);
  }
  if (method === 'GET' && s1 === 'worlds' && s3 === 'chat')         return getWorldChat(db, s2);
  if (method === 'GET' && s1 === 'worlds' && s3 === 'rankings')     return getWorldRankings(db, s2);
  if (method === 'GET' && s1 === 'worlds' && s3 === 'bounties' && !s4) return getBounties(db, s2);
  if (method === 'GET' && s1 === 'worlds' && s3 === 'trade' && s4 === 'offers') {
    const a = getAuth(req);
    return getOffers(db, s2, a?.uid || null);
  }
  if (method === 'GET' && s1 === 'worlds' && s3 === 'politics' && !s4) return getPolitics(db, s2);

  // Read-only public gameplay surfaces
  if (method === 'GET' && s1 === 'worlds' && s3 === 'morality' && !s4) {
    const a = getAuth(req);
    return morality.getIndex(db, s2, a?.uid || null);
  }
  if (method === 'GET' && s1 === 'worlds' && s3 === 'morality' && s4) return morality.getHistory(db, s2, s4);
  if (method === 'GET' && s1 === 'worlds' && s3 === 'currencies')     return currency.getList(db, s2);
  if (method === 'GET' && s1 === 'worlds' && s3 === 'cosmetics') {
    const a = getAuth(req);
    return cosmetics.getCatalog(db, s2, a?.uid || null);
  }
  if (method === 'GET' && s1 === 'worlds' && s3 === 'scouting')      return getScouting(db, s2);
  if (method === 'GET' && s1 === 'worlds' && s3 === 'items' && s4 === 'at') {
    // s5 is URL-encoded (e.g. "-23%2C5" for "-23,5"). Decode before parsing.
    return itemRoutes.getAt(db, s2, s5 ? decodeURIComponent(s5) : '');
  }
  if (method === 'GET' && s1 === 'worlds' && s3 === 'death-feed')    return lives.getDeathFeed(db, s2);
  if (method === 'GET' && s1 === 'worlds' && s3 === 'wealth')        return stats.getWealth(db, s2);
  if (method === 'GET' && s1 === 'worlds' && s3 === 'stats' && s4)   return stats.getForPlayer(db, s2, s4);
  if (method === 'GET' && s1 === 'worlds' && s3 === 'banks' && s4 === 'credibility') {
    const url = new URL(req.url, 'http://localhost');
    return banks.getCredibility(db, s2, url.searchParams.get('bankerUid') || '');
  }

  // ── Protected routes (single auth check) ─────────────────────────────────
  const auth = getAuth(req);
  if (!auth) throw apiError(401, 'not authenticated');

  // A signed token outlives the account it names (e.g. after a DB wipe). Reject
  // tokens whose user no longer exists so stale sessions can't keep playing.
  const account = await db.collection('users').findOne({ _id: auth.uid }, { projection: { _id: 1 } });
  if (!account) throw apiError(401, 'account no longer exists');

  // Bump per-world lastSeen so the cleanup tick can tell active players
  // from inactive ones. Fire-and-forget — never blocks the request.
  if (s1 === 'worlds' && s2) touchLastSeen(db, auth.uid, s2).catch(() => {});
  if (s1 === 'players' && s3 === 'worlds' && s4) touchLastSeen(db, auth.uid, s4).catch(() => {});
  if (s1 === 'actions' && body?.worldId) touchLastSeen(db, auth.uid, body.worldId).catch(() => {});

  // Worlds
  if (method === 'POST' && s1 === 'worlds' && s3 === 'chat')                         return postChat(db, auth, s2, body);
  if (method === 'GET'  && s1 === 'worlds' && s3 === 'tribes')                       return getTribes(db, auth, s2);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'tribes' && !s4)                return postCreateTribe(db, auth, s2, body);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'tribes' && s4 === 'join')      return postJoinTribe(db, auth, s2, body.tribeId);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'tribes' && s4 === 'leave')     return postLeaveTribe(db, auth, s2);
  if (method === 'GET'  && s1 === 'worlds' && s3 === 'houses')                       return getHouses(db, auth, s2);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'houses' && !s4)                return postCreateHouse(db, auth, s2, body);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'houses' && s4 === 'join')      return postRequestJoinHouse(db, auth, s2, body.houseId);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'houses' && s4 === 'cancel')    return postCancelJoinRequest(db, auth, s2, body.houseId);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'houses' && s4 === 'leave')     return postLeaveHouse(db, auth, s2);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'houses' && s4 && s5 === 'approve') return postApproveJoinRequest(db, auth, s2, s4, body.uid);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'houses' && s4 && s5 === 'reject')  return postRejectJoinRequest(db, auth, s2, s4, body.uid);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'bounties' && !s4)              return postBounty(db, auth, s2, body);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'bounties' && s4)               return postBountyClaim(db, auth, s2, s4);

  // Friends
  if (method === 'GET'  && s1 === 'worlds' && s3 === 'friends' && !s4)               return getFriends(db, auth, s2);
  if (method === 'GET'  && s1 === 'worlds' && s3 === 'friends' && s4 === 'requests') return getFriendRequests(db, auth, s2);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'friends' && s4 === 'requests') {
    const [, , , , , s5, s6] = p.split('/');
    if (!s5) return postFriendRequest(db, auth, s2, body);
    if (s6 === 'accept')  return postAcceptRequest(db, auth, s2, s5);
    if (s6 === 'decline') return postDeclineRequest(db, auth, s2, s5);
    throw apiError(400, 'friend request action required');
  }
  if (method === 'POST' && s1 === 'worlds' && s3 === 'friends' && s4) {
    const [, , , , , s5] = p.split('/');
    if (s5 === 'remove') return postRemoveFriend(db, auth, s2, s4);
    throw apiError(400, 'friend action required');
  }

  // Trade
  if (method === 'POST' && s1 === 'worlds' && s3 === 'trade' && s4 === 'offers') {
    const [, , , , , s5, s6] = p.split('/');
    if (!s5) return postOffer(db, auth, s2, body);
    if (s6) return postOfferAction(db, auth, s2, s5, s6, body);
    throw apiError(400, 'offer action required');
  }

  // Politics
  if (method === 'POST' && s1 === 'worlds' && s3 === 'politics' && s4)               return postVote(db, auth, s2, s4, body);

  // Authed gameplay reads (ransoms / trails / loans / stats — scoped to the caller)
  if (method === 'GET'  && s1 === 'worlds' && s3 === 'ransoms')                      return ransom.getList(db, s2, auth.uid);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'ransoms' && !s4)               return ransom.postProposal(db, auth, s2, body);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'ransoms' && s4)                return ransom.postResponse(db, auth, s2, s4, body);

  if (method === 'GET'  && s1 === 'worlds' && s3 === 'trails')                       return trails.getList(db, s2, auth.uid);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'trails' && !s4)                return trails.postCreate(db, auth, s2, body);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'trails' && s4)                 return trails.postSolve(db, auth, s2, s4, body);

  if (method === 'POST' && s1 === 'worlds' && s3 === 'morality')                     return morality.postAccusation(db, auth, s2, body);

  if (method === 'POST' && s1 === 'worlds' && s3 === 'currencies' && !s4)            return currency.postCreate(db, auth, s2, body);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'currencies' && s4)             return currency.postSetOfficial(db, auth, s2, s4, body);

  if (method === 'GET'  && s1 === 'worlds' && s3 === 'loans')                        return banks.getList(db, s2, auth.uid);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'loans' && !s4)                 return banks.postRequest(db, auth, s2, body);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'loans' && s4) {
    const [, , , , , s5] = p.split('/');
    if (!s5) throw apiError(400, 'loan action required');
    return banks.postAction(db, auth, s2, s4, s5, body);
  }

  if (method === 'POST' && s1 === 'worlds' && s3 === 'cosmetics' && !s4)             return cosmetics.postPurchase(db, auth, s2, body);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'cosmetics' && s4 === 'equip')  return cosmetics.postEquip(db, auth, s2, body);

  if (method === 'GET'  && s1 === 'worlds' && s3 === 'stats' && !s4)                 return stats.getMine(db, s2, auth.uid);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'stats')                        return stats.postFlag(db, auth, s2, body);

  // Items
  if (method === 'POST' && s1 === 'worlds' && s3 === 'items' && s4 === 'drop')       return itemRoutes.postDrop(db, auth, s2, body);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'items' && s4 === 'pickup')     return itemRoutes.postPickup(db, auth, s2, body);

  // Lives
  if (method === 'GET'  && s1 === 'worlds' && s3 === 'lives')                        return lives.getMine(db, s2, auth.uid);
  if (method === 'GET'  && s1 === 'worlds' && s3 === 'heirs')                        return lives.getHeirs(db, s2, auth.uid);
  if (method === 'GET'  && s1 === 'worlds' && s3 === 'characters')                   return lives.getActive(db, s2, auth.uid);
  if (method === 'GET'  && s1 === 'ethnicities')                                      return lives.getEthnicities();
  if (method === 'POST' && s1 === 'worlds' && s3 === 'lives' && s4 === 'control')    return lives.postControl(db, auth, s2, body);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'lives' && s4 === 'respawn')    return lives.postRespawn(db, auth, s2, body);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'lives' && s4 === 'reproduce')  return lives.postReproduce(db, auth, s2, body);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'lives' && !s4)                 return lives.postBirth(db, auth, s2, body);
  if (method === 'GET'  && s1 === 'worlds' && s3 === 'reports' && !s4)               return getReports(db, auth, s2);
  if (method === 'POST' && s1 === 'worlds' && s3 === 'reports' && s4)                return postReportRead(db, auth, s2, s4);

  // Players
  if (method === 'GET' && s1 === 'players' && s3 === 'worlds' && !s4) return getPlayerWorlds(db, auth, s2);
  if (method === 'GET' && s1 === 'players' && s3 === 'worlds' && s4)  return getPlayerWorldState(db, auth, s2, s4);

  // Actions
  if (method === 'POST' && s1 === 'actions') {
    const ctx = { uid: auth.uid, isGuest: auth.isGuest, data: body, db };

    if (s2 === 'attack')                return attack(ctx);
    if (s2 === 'equipItem')            return equipItem(ctx);
    if (s2 === 'buildStructure')        return buildStructure(ctx);
    if (s2 === 'addBuilding')           return addBuilding(ctx);
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
    if (s2 === 'spawnPlayer')           return spawnPlayer(ctx);
    if (s2 === 'startBuildingUpgrade')  return startBuildingUpgrade(ctx);
    if (s2 === 'startCrafting')         return startCrafting(ctx);
    if (s2 === 'startGathering')        return startGathering(ctx);
    if (s2 === 'startStructureUpgrade') return startStructureUpgrade(ctx);
    if (s2 === 'unloadGroup')           return unloadGroup(ctx);
    if (s2 === 'setStructureTaxes')     return setStructureTaxes(ctx);
    if (s2 === 'setStructureAccess')    return setStructureAccess(ctx);

    throw apiError(404, `unknown action: ${s2}`);
  }

  throw apiError(404, 'not found');
}
