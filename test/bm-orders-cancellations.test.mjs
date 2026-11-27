import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Prisma } from '../dist/generated/prisma/client.js';
import { ManagerOperationsService } from '../dist/modules/branch-manager/manager-operations.service.js';
import { CashLedgerService } from '../dist/modules/payments/cash-ledger.service.js';

const owner = { id: 'u-owner', role: 'OWNER', ownerId: 'owner-1', employeeId: null, branchId: null };
const manager = { id: 'u-mgr', role: 'MANAGER', ownerId: null, employeeId: 'emp-1', branchId: 'b1' };
const status = (code) => (error) => error?.getStatus?.() === code;

describe('GAP-310: Brand Manager reads orders of an assigned chain', () => {
  function build({ assigned = ['chain-1'], branchesInChain = ['b1', 'b2'], order = null } = {}) {
    const calls = { findMany: [], findFirst: [], audit: [] };
    const prisma = {
      ownerChainAssignment: { count: async ({ where }) => (assigned.includes(where.chainId) ? 1 : 0) },
      branch: { count: async ({ where }) => (branchesInChain.includes(where.id) ? 1 : 0) },
      order: {
        findMany: async (args) => (calls.findMany.push(args), []),
        count: async () => 0,
        findFirst: async (args) => (calls.findFirst.push(args), order),
      },
      branchAuditLog: { findMany: async (args) => (calls.audit.push(args), []) },
      user: { findMany: async () => [] },
      $transaction: async (items) => Promise.all(items),
    };
    const access = { assertCanAccessBranch: async () => undefined };
    return { service: new ManagerOperationsService(prisma, access), calls };
  }

  const query = { page: 1, limit: 20 };

  it('BM-05 needsAttention also returns cancelled orders whose late payment is not refunded yet', async () => {
    const { service, calls } = build();
    await service.chainOrders(owner, 'chain-1', { ...query, needsAttention: true, sortBy: 'attentionAt', sortOrder: 'asc' });
    const where = calls.findMany[0].where;
    // Order status is NOT forced to REQUIRES_ATTENTION: a late payment leaves the order CANCELLED.
    assert.equal(where.status, undefined);
    const attention = where.AND.find((part) => part.OR?.some((o) => o.status === 'REQUIRES_ATTENTION'));
    assert.ok(attention, 'attention filter present');
    assert.deepEqual(attention.OR[1], {
      payments: {
        some: {
          status: 'REQUIRES_ATTENTION',
          failureReason: { in: ['PAYMENT_RECEIVED_AFTER_CANCELLATION', 'PAYMENT_RECEIVED_AFTER_SWITCH_TO_CASH'] },
          refunds: { none: {} },
        },
      },
    });
    // Without the flag the search is unchanged.
    await service.chainOrders(owner, 'chain-1', { ...query });
    assert.equal(calls.findMany[1].where.AND.some((part) => part.OR?.some((o) => o.status === 'REQUIRES_ATTENTION')), false);
  });

  it('hideAwaitingPayment leaves out drafts and "Chờ thanh toán" orders unless a status is chosen', async () => {
    const { service, calls } = build();
    await service.chainOrders(owner, 'chain-1', { ...query, hideAwaitingPayment: true });
    const hidden = { NOT: { paymentStatus: 'UNPAID', status: { in: ['PENDING', 'CONFIRMED'] } } };
    assert.ok(calls.findMany[0].where.AND.some((part) => JSON.stringify(part) === JSON.stringify(hidden)));
    // Picking "Chờ thanh toán" in the status filter still finds them (e.g. to confirm a QR by hand).
    await service.chainOrders(owner, 'chain-1', { ...query, hideAwaitingPayment: true, status: 'CONFIRMED' });
    assert.equal(calls.findMany[1].where.status, 'CONFIRMED');
    assert.ok(!calls.findMany[1].where.AND.some((part) => part.NOT));
    const { ValidationPipe } = await import('@nestjs/common');
    const { ManagerOrderQueryDto } = await import('../dist/modules/branch-manager/manager.dto.js');
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    assert.equal((await pipe.transform({ hideAwaitingPayment: 'true' }, { type: 'query', metatype: ManagerOrderQueryDto })).hideAwaitingPayment, true);
  });

  it('needsAttention query string is parsed as a boolean', async () => {
    const { ValidationPipe } = await import('@nestjs/common');
    const { ManagerOrderQueryDto } = await import('../dist/modules/branch-manager/manager.dto.js');
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const parsed = await pipe.transform({ needsAttention: 'true' }, { type: 'query', metatype: ManagerOrderQueryDto });
    assert.equal(parsed.needsAttention, true);
    assert.equal((await pipe.transform({ needsAttention: 'false' }, { type: 'query', metatype: ManagerOrderQueryDto })).needsAttention, false);
  });

  it('searches the whole chain, with the branch of every order and the same pagination', async () => {
    const { service, calls } = build();
    const result = await service.chainOrders(owner, 'chain-1', { ...query, orderCode: 'CTR', status: 'COMPLETED' });
    const args = calls.findMany[0];
    assert.deepEqual(args.where.branch, { chainId: 'chain-1', deletedAt: null });
    assert.equal(args.where.branchId, undefined);
    assert.equal(args.where.status, 'COMPLETED');
    assert.deepEqual(args.where.orderCode, { contains: 'CTR', mode: 'insensitive' });
    assert.deepEqual(args.select.branch, { select: { id: true, code: true, name: true } });
    assert.equal(args.skip, 0);
    assert.equal(args.take, 20);
    assert.deepEqual(result, { items: [], total: 0, page: 1, limit: 20 });
  });

  it('narrows to one branch and the date range (from inclusive, to exclusive on placedAt)', async () => {
    const { service, calls } = build();
    await service.chainOrders(owner, 'chain-1', {
      ...query,
      branchId: 'b2',
      from: '2026-11-01T00:00:00.000+07:00',
      to: '2026-11-08T00:00:00.000+07:00',
    });
    const where = calls.findMany[0].where;
    assert.equal(where.branchId, 'b2');
    assert.equal(where.placedAt.gte.toISOString(), '2026-10-31T17:00:00.000Z');
    assert.equal(where.placedAt.lt.toISOString(), '2026-11-07T17:00:00.000Z');
  });

  it('answers 404 for a chain that is not assigned and for a branch outside the chain', async () => {
    const { service } = build();
    await assert.rejects(service.chainOrders(owner, 'chain-9', query), status(404));
    await assert.rejects(service.chainOrder(owner, 'chain-9', 'o1'), status(404));
    await assert.rejects(service.chainOrders(owner, 'chain-1', { ...query, branchId: 'other' }), status(404));
  });

  it('is for the Brand Manager only', async () => {
    const { service } = build();
    await assert.rejects(service.chainOrders(manager, 'chain-1', query), status(403));
  });

  it('returns the order detail in the Store Manager shape, scoped to the chain, with its audit by the order branch', async () => {
    const order = { id: 'o1', branchId: 'b2', branch: { id: 'b2' }, payments: [{ id: 'p1' }], tableSession: null, refunds: [], items: [] };
    const { service, calls } = build({ order });
    const detail = await service.chainOrder(owner, 'chain-1', 'o1');
    assert.deepEqual(calls.findFirst[0].where, { id: 'o1', branch: { chainId: 'chain-1', deletedAt: null } });
    assert.deepEqual(calls.findFirst[0].select.branch, { select: { id: true, code: true, name: true } });
    assert.equal(calls.audit[0].where.branchId, 'b2');
    assert.deepEqual(calls.audit[0].where.entityId.in, ['o1', 'p1']);
    assert.equal(detail.id, 'o1');
    assert.deepEqual(detail.audit, []);
  });

  it('answers 404 when the order is not in the chain', async () => {
    const { service } = build({ order: null });
    await assert.rejects(service.chainOrder(owner, 'chain-1', 'o-x'), status(404));
  });

  it('keeps the Store Manager routes unchanged: own branch only, no branch relation filter or select', async () => {
    const { service, calls } = build({ order: { id: 'o1', branchId: 'b1', payments: [], tableSession: null, refunds: [], items: [] } });
    await service.orders(manager, query);
    assert.equal(calls.findMany[0].where.branchId, 'b1');
    assert.equal(calls.findMany[0].where.branch, undefined);
    assert.equal(calls.findMany[0].select.branch, undefined);
    await service.order(manager, 'o1');
    assert.deepEqual(calls.findFirst[0].where, { id: 'o1', branchId: 'b1' });
    assert.equal(calls.findFirst[0].select.branch, undefined);
  });
});

describe('Cash ledger rows carry orderId', () => {
  it('returns orderId next to orderCode, null when the entry has no order', async () => {
    const entry = (id, orderId, order) => ({
      id,
      direction: 'INFLOW',
      sourceType: 'CASH_PAYMENT',
      paymentMethod: 'CASH',
      amount: new Prisma.Decimal(45000),
      occurredAt: new Date('2026-11-03T05:00:00.000Z'),
      branch: { id: 'b1', code: 'B1', name: 'CN 1' },
      orderId,
      order,
      payment: null,
      refund: null,
    });
    const prisma = {
      cashLedgerEntry: {
        findMany: async () => [
          entry('l1', 'order-1', { orderCode: 'CTR-1', callNumber: 7, businessDate: '2026-11-03' }),
          entry('l2', null, null),
        ],
        count: async () => 2,
        groupBy: async () => [],
      },
      employee: { findMany: async () => [] },
      branch: { findMany: async () => [] },
      $transaction: async (items) => Promise.all(items),
    };
    const service = new CashLedgerService(prisma, { assertCanAccessBranch: async () => undefined });
    const { items } = await service.listBranch(manager, 'b1');
    assert.deepEqual(
      items.map((item) => [item.orderId, item.orderCode]),
      [['order-1', 'CTR-1'], [null, null]],
    );
  });
});
