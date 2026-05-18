/**
 * Banks — player-run lending. Loans accrue interest each game tick and
 * auto-collect when due.
 *
 * Schema (`bank_loans`):
 *   _id, worldId, bankerUid, borrowerUid, principal, interestRate, termTicks,
 *   ticksElapsed, status: 'pending'|'active'|'repaid'|'defaulted',
 *   accruedDue, takenAt, activatedAt?, settledAt?
 *
 * Gold lives only inside structures/groups on chunk tiles — there is no
 * global wallet. Approving a loan charges the banker's sink and credits the
 * borrower's sink. Repayment runs the reverse. Tick-driven auto-collect
 * runs each tick.
 *
 * Banker credibility surfaces from completed-loan stats.
 */
import { ObjectId } from 'mongodb';
import { Ops } from '../lib/ops.js';
import { pay, charge } from './rewards.js';

export async function listFor(db, worldId, uid) {
  return db.collection('bank_loans')
    .find({ worldId, $or: [{ bankerUid: uid }, { borrowerUid: uid }] })
    .sort({ takenAt: -1 })
    .toArray();
}

export async function request(db, { worldId, bankerUid, borrowerUid, principal, interestRate, termTicks }) {
  if (bankerUid === borrowerUid) throw new Error('cannot loan to yourself');
  const insert = {
    worldId,
    bankerUid,
    borrowerUid,
    principal: Math.max(1, Math.floor(Number(principal) || 0)),
    interestRate: Math.max(0, Number(interestRate) || 0),
    termTicks: Math.max(1, Math.floor(Number(termTicks) || 24)),
    ticksElapsed: 0,
    status: 'pending',
    accruedDue: Math.floor(principal),
    takenAt: new Date()
  };
  const r = await db.collection('bank_loans').insertOne(insert);
  return { ...insert, _id: r.insertedId };
}

export async function approve(db, loanId) {
  const _id = new ObjectId(loanId);
  const loan = await db.collection('bank_loans').findOne({ _id });
  if (!loan || loan.status !== 'pending') throw new Error('loan not pending');

  const ops = new Ops();
  const charged = await charge(db, ops, loan.worldId, loan.bankerUid, { GOLD: loan.principal });
  if (!charged.ok) throw new Error(`banker: ${charged.reason}`);

  const paid = await pay(db, ops, loan.worldId, loan.borrowerUid, { GOLD: loan.principal });
  if (!paid) throw new Error('borrower has no resolvable structure to receive funds');

  await ops.flush(db);
  await db.collection('bank_loans').updateOne(
    { _id },
    { $set: { status: 'active', activatedAt: new Date(), payoutSink: paid, source: charged.sink } }
  );
  return db.collection('bank_loans').findOne({ _id });
}

export async function repay(db, loanId, amount) {
  const _id = new ObjectId(loanId);
  const loan = await db.collection('bank_loans').findOne({ _id });
  if (!loan || loan.status !== 'active') throw new Error('loan not active');

  const due = Math.min(loan.accruedDue, Math.max(1, Math.floor(Number(amount) || 0)));

  const ops = new Ops();
  const charged = await charge(db, ops, loan.worldId, loan.borrowerUid, { GOLD: due });
  if (!charged.ok) throw new Error(`borrower: ${charged.reason}`);
  await pay(db, ops, loan.worldId, loan.bankerUid, { GOLD: due });
  await ops.flush(db);

  const newDue = loan.accruedDue - due;
  const fullyRepaid = newDue <= 0;
  await db.collection('bank_loans').updateOne(
    { _id },
    {
      $set: {
        accruedDue: Math.max(0, newDue),
        status: fullyRepaid ? 'repaid' : 'active',
        settledAt: fullyRepaid ? new Date() : null
      }
    }
  );
  return db.collection('bank_loans').findOne({ _id });
}

/**
 * Tick: every active loan accrues interest, and ones past their term are
 * either auto-paid (if borrower has gold) or marked defaulted.
 */
export async function tick(db, worldId) {
  const active = await db.collection('bank_loans').find({ worldId, status: 'active' }).toArray();
  let defaults = 0;
  for (const loan of active) {
    const newElapsed = (loan.ticksElapsed || 0) + 1;
    const newDue = Math.ceil(loan.accruedDue * (1 + loan.interestRate));

    if (newElapsed >= loan.termTicks) {
      // Term expired — try to auto-collect from the borrower's sink.
      const ops = new Ops();
      const charged = await charge(db, ops, worldId, loan.borrowerUid, { GOLD: newDue });
      if (charged.ok) {
        await pay(db, ops, worldId, loan.bankerUid, { GOLD: newDue });
        await ops.flush(db);
        await db.collection('bank_loans').updateOne(
          { _id: loan._id },
          { $set: { status: 'repaid', accruedDue: 0, settledAt: new Date(), ticksElapsed: newElapsed } }
        );
      } else {
        await db.collection('bank_loans').updateOne(
          { _id: loan._id },
          { $set: { status: 'defaulted', accruedDue: newDue, settledAt: new Date(), ticksElapsed: newElapsed, defaultReason: charged.reason } }
        );
        defaults++;
      }
    } else {
      await db.collection('bank_loans').updateOne(
        { _id: loan._id },
        { $set: { accruedDue: newDue, ticksElapsed: newElapsed } }
      );
    }
  }
  return { defaults, processed: active.length };
}

/**
 * Banker credibility — % of loans successfully repaid (lifetime, this world).
 */
export async function credibility(db, worldId, bankerUid) {
  const all = await db.collection('bank_loans').find(
    { worldId, bankerUid, status: { $in: ['repaid', 'defaulted'] } }
  ).toArray();
  if (!all.length) return null;
  const repaid = all.filter((l) => l.status === 'repaid').length;
  return { repaid, total: all.length, ratio: repaid / all.length };
}
