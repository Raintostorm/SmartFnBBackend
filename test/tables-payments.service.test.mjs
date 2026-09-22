import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  OrderPaymentStatus,
  PaymentMethod,
  Prisma,
  TableStatus,
} from '../dist/generated/prisma/client.js';
import { AppRole } from '../dist/modules/auth/app-role.enum.js';
import { PaymentsService } from '../dist/modules/payments/payments.service.js';
import { TablesService } from '../dist/modules/tables/tables.service.js';

const employee = {
  id: 'user-id',
  email: 'waiter@example.com',
  phone: null,
  role: AppRole.WAITER,
  sessionId: 'session-id',
  employeeId: 'employee-id',
  ownerId: null,
  branchId: 'branch-id',
  chainId: 'chain-id',
  chainIds: [],
};

describe('TablesService', () => {
  it('stores table adjacency in both directions', async () => {
    let rows;
    const prisma = {
      restaurantTable: { count: async () => 3 },
      tableAdjacency: {},
      $transaction: async (work) =>
        work({
          tableAdjacency: {
            deleteMany: async () => undefined,
            createMany: async ({ data }) => {
              rows = data;
            },
          },
        }),
    };
    const access = { assertCanManageBranch: async () => undefined };
    const service = new TablesService(prisma, access);
    service.list = async () => [];

    await service.replaceAdjacency(
      'branch-id',
      'table-a',
      { adjacentTableIds: ['table-b', 'table-c'] },
      { ...employee, role: AppRole.MANAGER },
    );

    assert.deepEqual(rows, [
      { branchId: 'branch-id', tableId: 'table-a', adjacentTableId: 'table-b' },
      { branchId: 'branch-id', tableId: 'table-b', adjacentTableId: 'table-a' },
      { branchId: 'branch-id', tableId: 'table-a', adjacentTableId: 'table-c' },
      { branchId: 'branch-id', tableId: 'table-c', adjacentTableId: 'table-a' },
    ]);
  });

  it('does not make an occupied table available while it belongs to an open session', async () => {
    const prisma = {
      restaurantTable: {
        findFirst: async () => ({ id: 'table-id', branchId: 'branch-id' }),
      },
      tableSessionTable: { count: async () => 1 },
    };
    const access = { assertCanManageBranch: async () => undefined };
    const service = new TablesService(prisma, access);

    await assert.rejects(
      service.updateStatus('table-id', TableStatus.AVAILABLE, {
        ...employee,
        role: AppRole.MANAGER,
      }),
      (error) => error?.getStatus?.() === 409,
    );
  });
});

describe('PaymentsService', () => {
  it('rejects a payment larger than the remaining table-session balance', async () => {
    const prisma = {
      tableSession: {
        findFirst: async () => ({ id: 'session-id', paymentStatus: OrderPaymentStatus.UNPAID }),
      },
      order: { findMany: async () => [{ totalAmount: new Prisma.Decimal(100) }] },
      payment: { findMany: async () => [{ amount: new Prisma.Decimal(80) }] },
    };
    const service = new PaymentsService(prisma, {});

    await assert.rejects(
      service.createForTableSession(
        'session-id',
        { method: PaymentMethod.CASH, amount: 30 },
        employee,
      ),
      (error) => error?.getStatus?.() === 409,
    );
  });

  it('creates a pending payment when it fits the remaining balance', async () => {
    let created;
    const prisma = {
      tableSession: {
        findFirst: async () => ({ id: 'session-id', paymentStatus: OrderPaymentStatus.UNPAID }),
      },
      order: { findMany: async () => [{ totalAmount: new Prisma.Decimal(100) }] },
      payment: {
        findMany: async () => [{ amount: new Prisma.Decimal(20) }],
        create: async ({ data }) => {
          created = data;
          return data;
        },
      },
    };
    const service = new PaymentsService(prisma, {});

    await service.createForTableSession(
      'session-id',
      { method: PaymentMethod.CARD, amount: 80 },
      employee,
    );

    assert.equal(created.tableSessionId, 'session-id');
    assert.equal(created.amount, 80);
  });

  it('marks the session and its orders complete after full payment', async () => {
    let sessionUpdate;
    let orderUpdate;
    const tx = {
      order: {
        findMany: async () => [{ id: 'order-id', totalAmount: new Prisma.Decimal(100) }],
        updateMany: async (args) => {
          orderUpdate = args;
        },
      },
      payment: { findMany: async () => [{ amount: new Prisma.Decimal(100) }] },
      tableSession: {
        update: async (args) => {
          sessionUpdate = args;
        },
      },
    };
    const service = new PaymentsService({}, {});
    const paidAt = new Date('2026-09-22T12:00:00.000Z');

    await service.refreshTableSessionPaymentState(tx, 'session-id', paidAt);

    assert.equal(sessionUpdate.data.status, 'PAID');
    assert.equal(sessionUpdate.data.paymentStatus, 'PAID');
    assert.equal(orderUpdate.data.status, 'COMPLETED');
    assert.equal(orderUpdate.data.paymentStatus, 'PAID');
    assert.equal(orderUpdate.data.completedAt, paidAt);
  });
});
