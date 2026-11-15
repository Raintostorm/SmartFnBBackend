import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Prisma } from '../dist/generated/prisma/client.js';
import { ManagerOperationsService } from '../dist/modules/branch-manager/manager-operations.service.js';
import { CashLedgerService } from '../dist/modules/payments/cash-ledger.service.js';
import { ReportsService } from '../dist/modules/reports/reports.service.js';

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

describe('BR-50: GET /reports/cancellations', () => {
  const branchRows = [
    { id: 'b1', code: 'B1', name: 'CN 1', city: 'HCM', chainId: 'c1', chain: { timezone: 'Asia/Ho_Chi_Minh' } },
    { id: 'b2', code: 'B2', name: 'CN 2', city: 'HCM', chainId: 'c1', chain: { timezone: 'Asia/Ho_Chi_Minh' } },
  ];
  const person = (id, first) => ({ id, employeeCode: `E-${id}`, firstName: first, lastName: 'Trần' });

  function build({ branches = branchRows, orders = [], total = 0, raw = [] } = {}) {
    const calls = { count: [], findMany: [], raw: [], employees: [] };
    const prisma = {
      branch: { findMany: async () => branches },
      order: {
        count: async (args) => (calls.count.push(args), total),
        findMany: async (args) => (calls.findMany.push(args), orders),
      },
      employee: { findMany: async (args) => (calls.employees.push(args), [person('e1', 'Lan'), person('e2', 'Minh')]) },
      $queryRaw: async (...args) => (calls.raw.push(args), raw),
    };
    const access = { getAccessibleBranchIds: async () => branches.map((b) => b.id) };
    const plans = { assertFeatureEnabled: async () => undefined };
    return { service: new ReportsService(prisma, access, plans), calls };
  }

  const cancelledOrder = {
    id: 'o1',
    orderCode: 'CTR-1-AF0042',
    callNumber: 12,
    totalAmount: new Prisma.Decimal(75000),
    cancelledAt: new Date('2026-11-03T05:00:00.000Z'),
    cancellationReason: 'Khách đổi ý',
    branch: { id: 'b1', code: 'B1', name: 'CN 1' },
    cancelledBy: person('e1', 'Lan'),
    refunds: [
      { id: 'r1', amount: new Prisma.Decimal(50000), status: 'COMPLETED', method: 'CASH', reason: 'Huỷ', note: null, requestedByEmployeeId: 'e1', completedByEmployeeId: 'e2' },
      { id: 'r2', amount: new Prisma.Decimal(25000), status: 'PENDING', method: 'CASH', reason: null, note: 'chờ', requestedByEmployeeId: 'e1', completedByEmployeeId: null },
    ],
  };

  it('keeps the contract the Web calls: totals, the latest orders, who cancelled and who completed each refund', async () => {
    const { service } = build({
      orders: [cancelledOrder],
      total: 3,
      raw: [{ count: 2n, refund_amount: '75000.00', pending_refund_amount: '25000.00' }],
    });
    const result = await service.getCancellations(owner, { from: '2026-11-01', to: '2026-11-07', limit: 10 });
    assert.equal(result.total, 3);
    assert.equal(result.paidCancellationCount, 2);
    assert.equal(result.refundAmount, '75000.00');
    assert.equal(result.pendingRefundAmount, '25000.00');
    assert.equal(result.limit, 10);
    const [item] = result.items;
    assert.equal(item.orderCode, 'CTR-1-AF0042');
    assert.equal(item.callNumber, 12);
    assert.equal(item.totalAmount, '75000.00');
    assert.equal(item.reason, 'Khách đổi ý');
    assert.deepEqual(item.branch, { id: 'b1', code: 'B1', name: 'CN 1' });
    assert.equal(item.cancelledBy.firstName, 'Lan');
    assert.equal(item.refundAmount, '75000.00');
    assert.equal(item.refunds[0].completedBy.firstName, 'Minh');
    assert.equal(item.refunds[0].requestedBy.firstName, 'Lan');
    assert.equal(item.refunds[1].completedBy, null);
    assert.equal(item.refunds[1].status, 'PENDING');
  });

  it('puts orders on the range by cancelledAt and refunds by their cancellation date, in Vietnam time', async () => {
    const { service, calls } = build();
    await service.getCancellations(owner, { from: '2026-11-01', to: '2026-11-07', limit: 5 });
    const where = calls.findMany[0].where;
    assert.equal(where.status, 'CANCELLED');
    assert.deepEqual(where.branchId, { in: ['b1', 'b2'] });
    assert.equal(where.cancelledAt.gte.toISOString(), '2026-10-31T17:00:00.000Z');
    assert.equal(where.cancelledAt.lt.toISOString(), '2026-11-07T17:00:00.000Z');
    assert.equal(calls.findMany[0].take, 5);
    assert.deepEqual(calls.findMany[0].orderBy, [{ cancelledAt: 'desc' }, { id: 'asc' }]);
    const [strings, ...values] = calls.raw[0];
    assert.match(strings.join('?'), /r\.cancellation_date >= \?::date/);
    assert.deepEqual(values, [['b1', 'b2'], '2026-11-01', '2026-11-07']);
  });

  it('returns an empty report when no branch is in scope, and reads names only when there are refunds', async () => {
    const empty = build({ branches: [] });
    const result = await empty.service.getCancellations(owner, { limit: 10 });
    assert.deepEqual(result, { total: 0, paidCancellationCount: 0, refundAmount: '0.00', pendingRefundAmount: '0.00', limit: 10, items: [] });
    const noRefunds = build({ orders: [{ ...cancelledOrder, refunds: [] }], total: 1 });
    const none = await noRefunds.service.getCancellations(owner, { from: '2026-11-01', to: '2026-11-07', limit: 10 });
    assert.equal(noRefunds.calls.employees.length, 0);
    assert.equal(none.items[0].refundAmount, '0.00');
  });

  it('is for the Brand Manager only, like the other report routes', async () => {
    const { service } = build();
    await assert.rejects(service.getCancellations(manager, { limit: 10 }), status(403));
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
