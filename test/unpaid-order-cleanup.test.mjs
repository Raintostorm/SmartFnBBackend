import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STALE_UNPAID_REASON, UnpaidOrderCleanupWorker } from '../dist/modules/counter-operations/unpaid-order-cleanup.worker.js';
import { validateEnvironment } from '../dist/config/environment.validation.js';

const config = (values = {}) => ({ get: (name, fallback) => (name in values ? values[name] : fallback) });

function build({ stale = [{ id: 'o1' }], order = { branchId: 'b1', items: [{ menuItemId: 'm1', quantity: 2 }, { menuItemId: null, quantity: 1 }] }, updated = 1 } = {}) {
  const calls = { findMany: null, updates: [], portions: [], events: [] };
  const tx = {
    order: {
      findFirst: async () => order,
      updateMany: async (args) => (calls.updates.push(args), { count: updated }),
    },
    branchMenuItem: { updateMany: async (args) => (calls.portions.push(args), { count: 1 }) },
  };
  const prisma = {
    order: { findMany: async (args) => ((calls.findMany = args), stale) },
    $transaction: async (work) => work(tx),
  };
  const realtime = { branch: (branchId, type, data) => calls.events.push({ branchId, type, data }) };
  return { worker: new UnpaidOrderCleanupWorker(prisma, config({ UNPAID_ORDER_TTL_MINUTES: 30, UNPAID_ORDER_CLEANUP_BATCH_SIZE: 50 }), realtime), calls };
}

describe('Auto-cancel counter orders left "Chờ thanh toán"', () => {
  const now = new Date('2026-11-27T08:00:00.000Z');

  it('selects finalized, unpaid counter orders idle past the TTL with no live payment', async () => {
    const { worker, calls } = build({ stale: [] });
    await worker.runOnce(now);
    const where = calls.findMany.where;
    assert.equal(where.type, 'COUNTER_PICKUP');
    assert.equal(where.status, 'CONFIRMED');
    assert.equal(where.paymentStatus, 'UNPAID');
    assert.equal(where.updatedAt.lte.toISOString(), '2026-11-27T07:30:00.000Z');
    // A QR still waiting, money received, a mismatch or a late payment keeps the order.
    assert.deepEqual(where.payments, { none: { status: { in: ['PENDING', 'SUCCESS', 'AMOUNT_MISMATCH', 'REQUIRES_ATTENTION'] } } });
    assert.equal(calls.findMany.take, 50);
  });

  it('cancels with a system reason, gives reserved portions back and tells the branch', async () => {
    const { worker, calls } = build();
    assert.equal(await worker.runOnce(now), 1);
    assert.deepEqual(calls.updates[0].data, { status: 'CANCELLED', cancelledAt: now, cancellationReason: STALE_UNPAID_REASON });
    // The update re-checks the same condition, so an order paid meanwhile is not touched.
    assert.equal(calls.updates[0].where.status, 'CONFIRMED');
    assert.equal(calls.updates[0].where.paymentStatus, 'UNPAID');
    assert.deepEqual(calls.portions, [
      { where: { branchId: 'b1', menuItemId: 'm1', remainingPortions: { not: null } }, data: { remainingPortions: { increment: 2 } } },
    ]);
    assert.deepEqual(calls.events, [{ branchId: 'b1', type: 'cashier.order.updated', data: { orderId: 'o1', status: 'CANCELLED', reason: 'STALE_UNPAID' } }]);
  });

  it('skips an order that was paid or changed in the meantime', async () => {
    const paid = build({ order: null });
    assert.equal(await paid.worker.runOnce(now), 0);
    assert.equal(paid.calls.updates.length, 0);
    const raced = build({ updated: 0 });
    assert.equal(await raced.worker.runOnce(now), 0);
    assert.equal(raced.calls.portions.length, 0);
    assert.equal(raced.calls.events.length, 0);
  });

  it('is configurable and validated (default on, 30 minutes)', () => {
    const base = { DATABASE_URL: 'postgresql://localhost/test', JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'b'.repeat(32) };
    const env = validateEnvironment(base);
    assert.equal(env.UNPAID_ORDER_CLEANUP_ENABLED, true);
    assert.equal(env.UNPAID_ORDER_TTL_MINUTES, 30);
    assert.throws(() => validateEnvironment({ ...base, UNPAID_ORDER_TTL_MINUTES: '2' }), /UNPAID_ORDER_TTL_MINUTES/);
  });
});
