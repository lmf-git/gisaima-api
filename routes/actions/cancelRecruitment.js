import { getChunkKey } from 'gisaima-shared/map/cartography.js';
import { applyUpdates } from '../../db/adapter.js';

export async function cancelRecruitment({ uid, data, db }) {
  const { recruitmentId, structureId, x, y, worldId } = data;
  if (!recruitmentId || !structureId || x === undefined || y === undefined || !worldId) {
    throw err(400, 'Missing required parameters');
  }

  const chunkKey    = getChunkKey(x, y);
  const tileKey     = `${x},${y}`;
  const chunkDoc    = await db.collection('chunks').findOne({ worldId, chunkKey });
  const structure   = chunkDoc?.tiles?.[tileKey]?.structure;
  const recruitment = structure?.recruitmentQueue?.[recruitmentId];

  if (!recruitment)              throw err(404, 'Recruitment not found');
  if (recruitment.owner !== uid) throw err(403, 'You can only cancel your own recruitments');

  const now       = Date.now();
  const totalTime = recruitment.completesAt - recruitment.startedAt;
  const elapsed   = now - recruitment.startedAt;
  const progress  = Math.min(100, Math.floor((elapsed / totalTime) * 100));
  const refundPct = Math.max(50, 100 - progress);

  const bank    = _normalizeItems(structure.banks?.[uid] || {});
  const refunds = {};
  for (const [rk, amount] of Object.entries(recruitment.cost || {})) {
    const refund = Math.floor(amount * refundPct / 100);
    if (refund <= 0) continue;
    refunds[rk] = refund;
    const key = rk.toUpperCase();
    bank[key] = (bank[key] || 0) + refund;
  }

  const structPath = `worlds/${worldId}/chunks/${chunkKey}/${tileKey}/structure`;
  const updates = {
    [`${structPath}/recruitmentQueue/${recruitmentId}`]: null,
    [`${structPath}/banks/${uid}`]: bank
  };

  await applyUpdates(db, updates);
  return { success: true, refunds, refundPercent: refundPct };
}

function _normalizeItems(items) {
  if (!items || typeof items !== 'object') return {};
  if (Array.isArray(items)) {
    const out = {};
    for (const item of items) {
      if (!item) continue;
      const k = (item.id || item.name || '').toUpperCase();
      if (k) out[k] = (out[k] || 0) + (item.quantity || 0);
    }
    return out;
  }
  const out = {};
  for (const [k, v] of Object.entries(items)) out[k.toUpperCase()] = v;
  return out;
}

function err(status, msg) { return Object.assign(new Error(msg), { status }); }

export default cancelRecruitment;
