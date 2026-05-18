import { apiError } from '../core/auth.js';
import * as banks from '../db/banks.js';

export async function getList(db, worldId, uid) {
  if (!uid) return { items: [] };
  return { items: await banks.listFor(db, worldId, uid) };
}

export async function postRequest(db, auth, worldId, body) {
  try {
    const doc = await banks.request(db, {
      worldId,
      bankerUid: body?.bankerUid,
      borrowerUid: auth.uid,
      principal: body?.principal,
      interestRate: body?.interestRate,
      termTicks: body?.termTicks
    });
    return { ok: true, loan: doc };
  } catch (e) {
    throw apiError(400, e.message);
  }
}

export async function postAction(db, auth, _worldId, loanId, action, body) {
  try {
    if (action === 'approve') return { ok: true, loan: await banks.approve(db, loanId) };
    if (action === 'repay')   return { ok: true, loan: await banks.repay(db, loanId, body?.amount) };
    throw new Error(`unknown loan action: ${action}`);
  } catch (e) {
    throw apiError(400, e.message);
  }
}

export async function getCredibility(db, worldId, bankerUid) {
  return banks.credibility(db, worldId, bankerUid);
}
