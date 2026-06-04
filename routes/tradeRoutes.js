import { apiError } from '../core/auth.js';
import { getPlayerWorldData } from '../db/players.js';
import {
  createRoute, listRoutes, runRoute, setAutoship, archiveRoute,
} from '../db/tradeRoutes.js';

export async function getRoutes(db, auth, worldId) {
  return { items: await listRoutes(db, worldId, auth.uid) };
}

export async function postRoute(db, auth, worldId, body) {
  const me = await getPlayerWorldData(db, auth.uid, worldId);
  if (!me) throw apiError(403, 'must have joined this world');

  const fromX = Math.floor(Number(body?.fromX));
  const fromY = Math.floor(Number(body?.fromY));
  const toX = Math.floor(Number(body?.toX));
  const toY = Math.floor(Number(body?.toY));
  if (![fromX, fromY, toX, toY].every(Number.isFinite)) throw apiError(400, 'from/to coordinates required');

  try {
    const route = await createRoute(db, worldId, auth.uid, me.displayName, {
      fromX, fromY, toX, toY,
      items: body?.items || {},
      autoship: !!body?.autoship,
      template: !!body?.template || !!body?.autoship,
    });
    return { ok: true, route };
  } catch (e) {
    throw apiError(400, e.message);
  }
}

export async function postRouteAction(db, auth, worldId, routeId, action, body) {
  try {
    if (action === 'run')      return { ok: true, ...(await runRoute(db, worldId, auth.uid, routeId)) };
    if (action === 'autoship') return await setAutoship(db, worldId, auth.uid, routeId, !!body?.on);
    if (action === 'delete')   return await archiveRoute(db, worldId, auth.uid, routeId);
  } catch (e) {
    throw apiError(400, e.message);
  }
  throw apiError(400, `unknown route action: ${action}`);
}
