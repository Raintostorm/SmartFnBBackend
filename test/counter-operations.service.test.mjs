import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CounterOperationsService } from '../dist/modules/counter-operations/counter-operations.service.js';
import { BadRequestException, ConflictException } from '@nestjs/common';

const cashier = {
  id: 'user-id',
  email: 'cashier@example.com',
  role: 'CASHIER',
  sessionId: 'session-id',
  employeeId: 'cashier-id',
  branchId: 'branch-id',
  ownerId: null,
  chainId: null,
  chainIds: [],
};

const barista = { ...cashier, role: 'BARISTA', employeeId: 'barista-id' };
const writableBranch = { assertSubscriptionAllowsWrite: async () => undefined };
const counterService = (prisma, branchAccess = writableBranch) =>
  new CounterOperationsService(prisma, branchAccess);

describe('V9 counter operations', () => {
  it('returns separate chain, branch, and effective menu availability', async () => {
    const service = counterService({
      $transaction: async (queries) => Promise.all(queries),
      branch: {
        findUniqueOrThrow: async () => ({
          id: 'branch-id',
          chainId: 'chain-id',
          name: 'Q1',
          timezone: 'Asia/Ho_Chi_Minh',
          chain: { currency: 'VND' },
        }),
      },
      branchMenuItem: {
        findMany: async () => [
          {
            branchId: 'branch-id',
            menuItemId: 'drink-id',
            isEnabled: true,
            isAvailable: true,
            remainingPortions: 0,
            menuItem: {
              id: 'drink-id',
              name: 'Trà sữa',
              price: 30000,
              isActive: true,
              isAvailable: true,
              category: { id: 'drinks', name: 'Đồ uống' },
              optionGroups: [
                {
                  displayOrder: 0,
                  group: {
                    id: 'topping-group',
                    name: 'Topping',
                    isActive: true,
                    options: [
                      {
                        id: 'pearl',
                        name: 'Trân châu',
                        isActive: true,
                        branchAvailability: [{ isAvailable: false }],
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    });

    const context = await service.cashierContext(cashier);
    const item = context.menuItems[0];
    assert.equal(item.chainAvailable, true);
    assert.equal(item.branchAvailable, true);
    assert.equal(item.effectiveAvailable, false);
    assert.equal(item.unavailableReason, 'NO_REMAINING_PORTIONS');
    assert.equal(item.menuItem.optionGroups[0].group.options[0].branchAvailable, false);
    assert.equal(item.menuItem.optionGroups[0].group.options[0].effectiveAvailable, false);
  });

  it('keeps an owner-disabled item visible but marks it unavailable', async () => {
    const service = counterService({
      $transaction: async (queries) => Promise.all(queries),
      branch: { findUniqueOrThrow: async () => ({ id: 'branch-id' }) },
      branchMenuItem: {
        findMany: async () => [
          {
            branchId: 'branch-id',
            menuItemId: 'drink-id',
            isEnabled: true,
            isAvailable: true,
            remainingPortions: null,
            menuItem: {
              id: 'drink-id',
              isActive: false,
              isAvailable: true,
              optionGroups: [],
            },
          },
        ],
      },
    });

    const context = await service.cashierContext(cashier);
    assert.equal(context.menuItems.length, 1);
    assert.equal(context.menuItems[0].chainAvailable, false);
    assert.equal(context.menuItems[0].effectiveAvailable, false);
    assert.equal(context.menuItems[0].unavailableReason, 'CHAIN_DISABLED');
  });

  it('blocks a new sale when the subscription is read-only', async () => {
    const service = counterService(
      {},
      {
        assertSubscriptionAllowsWrite: async () => {
          const error = new Error('read-only');
          error.getStatus = () => 403;
          throw error;
        },
      },
    );
    await assert.rejects(service.createDraft(cashier, {}), (error) => error?.getStatus?.() === 403);
  });

  it('does not accept less cash than the locked order total', async () => {
    const tx = {
      posStation: { findFirst: async () => ({ id: 'station-id' }) },
      order: {
        findFirst: async () => ({
          id: 'order-id',
          status: 'CONFIRMED',
          paymentStatus: 'UNPAID',
          totalAmount: { toString: () => '50000' },
          items: [{ id: 'item-id', quantity: 1 }],
        }),
      },
    };
    // Prisma Decimal methods are needed for the amount comparison; use the generated implementation.
    const { Prisma } = await import('../dist/generated/prisma/client.js');
    tx.order.findFirst = async () => ({
      id: 'order-id',
      status: 'CONFIRMED',
      paymentStatus: 'UNPAID',
      totalAmount: new Prisma.Decimal(50000),
      items: [{ id: 'item-id', quantity: 1 }],
    });
    const service = counterService({ $transaction: (callback) => callback(tx) });
    await assert.rejects(
      () =>
        service.collectCash(cashier, 'order-id', {
          stationId: 'station-id',
          tenderedAmount: 40000,
        }),
      BadRequestException,
    );
  });

  it('does not finalize an empty counter order', async () => {
    const tx = {
      order: {
        findFirst: async () => ({ id: 'order-id', status: 'PENDING', items: [] }),
      },
    };
    const service = counterService({ $transaction: (callback) => callback(tx) });
    await assert.rejects(() => service.finalize(cashier, 'order-id'), BadRequestException);
  });

  it('does not finalize the same order twice', async () => {
    const tx = {
      order: {
        findFirst: async () => ({
          id: 'order-id',
          status: 'CONFIRMED',
          items: [{ id: 'item-id' }],
        }),
      },
    };
    const service = counterService({ $transaction: (callback) => callback(tx) });
    await assert.rejects(() => service.finalize(cashier, 'order-id'), ConflictException);
  });

  it('does not collect payment through a station outside the cashier branch', async () => {
    const { Prisma } = await import('../dist/generated/prisma/client.js');
    const service = counterService({
      $transaction: (callback) =>
        callback({
          order: {
            findFirst: async () => ({
              id: 'order-id',
              status: 'CONFIRMED',
              paymentStatus: 'UNPAID',
              totalAmount: new Prisma.Decimal(50000),
              items: [{ id: 'item-id', quantity: 1 }],
            }),
          },
          posStation: { findFirst: async () => null },
        }),
    });
    await assert.rejects(
      () =>
        service.collectCash(cashier, 'order-id', {
          stationId: 'foreign-station',
          tenderedAmount: 50000,
        }),
      /Active POS station was not found in your branch/,
    );
  });

  it('cancels only an unpaid confirmed order and records the cashier and reason', async () => {
    let mutation;
    let restored;
    const tx = {
      order: {
        findFirst: async () => ({ items: [{ menuItemId: 'drink-id', quantity: 2 }] }),
        updateMany: async (args) => {
          mutation = args;
          return { count: 1 };
        },
      },
      branchMenuItem: {
        updateMany: async (args) => {
          restored = args;
          return { count: 1 };
        },
      },
    };
    const service = counterService({
      $transaction: (callback) => callback(tx),
    });
    assert.deepEqual(await service.cancelUnpaid(cashier, 'order-id', 'Khách đổi món'), {
      cancelled: true,
    });
    assert.equal(mutation.where.branchId, 'branch-id');
    assert.equal(mutation.where.status, 'CONFIRMED');
    assert.equal(mutation.where.paymentStatus, 'UNPAID');
    assert.equal(mutation.data.cancelledById, 'cashier-id');
    assert.equal(mutation.data.cancellationReason, 'Khách đổi món');
    assert.equal(restored.where.menuItemId, 'drink-id');
    assert.equal(restored.data.remainingPortions.increment, 2);
  });

  it('atomically rejects checkout when another cashier takes the last portion', async () => {
    const { Prisma } = await import('../dist/generated/prisma/client.js');
    const tx = {
      order: { create: async () => ({ id: 'order-id' }) },
      branchMenuItem: {
        findUnique: async () => ({
          isEnabled: true,
          isAvailable: true,
          menuItem: {
            name: 'Cà phê',
            price: new Prisma.Decimal(30000),
            isActive: true,
            isAvailable: true,
            optionGroups: [],
          },
        }),
        findFirst: async () => ({ remainingPortions: 1 }),
        updateMany: async () => ({ count: 0 }),
      },
      branchMenuOption: { count: async () => 0 },
    };
    const service = counterService({ $transaction: (callback) => callback(tx) });
    await assert.rejects(
      () =>
        service.checkout(cashier, {
          items: [{ menuItemId: 'drink-id', quantity: 1, optionIds: [] }],
        }),
      /no longer has enough portions/,
    );
  });

  it('rechecks option availability before taking cash', async () => {
    const { Prisma } = await import('../dist/generated/prisma/client.js');
    const tx = {
      order: {
        findFirst: async () => ({
          id: 'order-id',
          status: 'CONFIRMED',
          paymentStatus: 'UNPAID',
          totalAmount: new Prisma.Decimal(50000),
          items: [
            {
              id: 'line-1',
              menuItemId: 'drink-id',
              quantity: 2,
              selectedOptions: [{ id: 'topping-id' }],
            },
          ],
        }),
      },
      posStation: { findFirst: async () => ({ id: 'station-id' }) },
      branchMenuItem: {
        findUnique: async () => ({
          isEnabled: true,
          isAvailable: true,
          menuItem: {
            isActive: true,
            isAvailable: true,
            deletedAt: null,
            optionGroups: [
              {
                groupId: 'topping-group',
                group: {
                  isActive: true,
                  minSelections: 0,
                  maxSelections: 2,
                  options: [{ id: 'topping-id', isActive: true }],
                },
              },
            ],
          },
        }),
      },
      branchMenuOption: { count: async () => 1 },
    };
    const service = counterService({ $transaction: (callback) => callback(tx) });
    await assert.rejects(
      () =>
        service.collectCash(cashier, 'order-id', {
          stationId: 'station-id',
          tenderedAmount: 50000,
        }),
      /option is no longer available/,
    );
  });

  it('replaces an editable item and recalculates the order total', async () => {
    const { Prisma } = await import('../dist/generated/prisma/client.js');
    let updated;
    let total;
    const tx = {
      orderItem: {
        findFirst: async () => ({ id: 'line-1' }),
        update: async (args) => {
          updated = args.data;
          return { id: 'line-1', ...args.data };
        },
        aggregate: async () => ({ _sum: { totalPrice: new Prisma.Decimal(70000) } }),
      },
      order: {
        update: async (args) => {
          total = args.data.totalAmount;
        },
      },
      branchMenuItem: {
        findUnique: async () => ({
          isEnabled: true,
          isAvailable: true,
          menuItem: {
            name: 'Trà sữa',
            price: new Prisma.Decimal(30000),
            isActive: true,
            isAvailable: true,
            optionGroups: [
              {
                groupId: 'size-group',
                group: {
                  id: 'size-group',
                  code: 'SIZE',
                  name: 'Size',
                  isActive: true,
                  minSelections: 1,
                  maxSelections: 1,
                  options: [
                    {
                      id: 'large',
                      groupId: 'size-group',
                      code: 'L',
                      name: 'L',
                      isActive: true,
                      priceDelta: new Prisma.Decimal(5000),
                    },
                  ],
                },
              },
            ],
          },
        }),
      },
      branchMenuOption: { count: async () => 0 },
    };
    const service = counterService({ $transaction: (callback) => callback(tx) });
    await service.updateItem(cashier, 'order-id', 'line-1', {
      menuItemId: 'drink-id',
      quantity: 2,
      optionIds: ['large'],
      specialInstructions: 'Ít đá',
    });
    assert.equal(updated.quantity, 2);
    assert.equal(updated.totalPrice.toString(), '70000');
    assert.equal(updated.specialInstructions, 'Ít đá');
    assert.equal(total.toString(), '70000');
  });

  it('groups queued cups by item and size while preserving the oldest cup first', async () => {
    const paidAt = new Date('2026-09-29T01:00:00Z');
    const makeUnit = (id, callNumber, size, offsetMinutes) => ({
      id,
      sequence: 1,
      status: 'QUEUED',
      startedAt: null,
      startedById: null,
      createdAt: new Date(paidAt.getTime() + offsetMinutes * 60_000),
      orderItem: {
        orderId: `order-${id}`,
        menuItemId: 'milk-tea',
        menuItem: { categoryId: 'drinks', allowBatching: true },
        itemName: 'Trà sữa',
        selectedOptions: [{ groupCode: 'SIZE', groupName: 'Size', name: size }],
        specialInstructions: null,
        order: { callNumber, paidAt: new Date(paidAt.getTime() + offsetMinutes * 60_000) },
      },
    });
    const service = counterService({
      orderItemUnit: {
        findMany: async () => [
          makeUnit('oldest', 1, 'L', 0),
          makeUnit('same-size', 2, 'L', 2),
          makeUnit('different-size', 3, 'M', 3),
          makeUnit('outside-window', 4, 'L', 7),
        ],
      },
    });
    const batches = await service.baristaQueue(barista);
    assert.deepEqual(
      batches[0].units.map((unit) => unit.id),
      ['oldest', 'same-size'],
    );
    assert.equal(batches[1].size, 'M');
    assert.equal(batches[2].units[0].id, 'outside-window');
  });

  it('keeps every unit separate when the owner disables batching', async () => {
    const paidAt = new Date('2026-09-29T01:00:00Z');
    const makeUnit = (id, callNumber) => ({
      id,
      sequence: 1,
      status: 'QUEUED',
      startedAt: null,
      startedById: null,
      createdAt: paidAt,
      orderItem: {
        orderId: `order-${id}`,
        menuItemId: 'smoothie',
        menuItem: { categoryId: 'drinks', allowBatching: false },
        itemName: 'Sinh tố',
        selectedOptions: [{ groupCode: 'SIZE', groupName: 'Size', name: 'L' }],
        specialInstructions: null,
        order: { callNumber, paidAt },
      },
    });
    const service = counterService({
      orderItemUnit: { findMany: async () => [makeUnit('one', 1), makeUnit('two', 2)] },
    });

    const batches = await service.baristaQueue(barista);
    assert.equal(batches.length, 2);
    assert.deepEqual(
      batches.map((batch) => batch.units.length),
      [1, 1],
    );
  });

  it('does not let another barista complete a claimed batch', async () => {
    const tx = {
      orderItemUnit: {
        findMany: async () => [
          {
            id: 'unit-1',
            orderItemId: 'item-1',
            orderItem: { orderId: 'order-1' },
          },
        ],
        updateMany: async () => ({ count: 0 }),
      },
    };
    const service = counterService({ $transaction: (callback) => callback(tx) });
    await assert.rejects(
      () => service.completeBatch(barista, ['unit-1']),
      /Only the barista who claimed this batch/,
    );
  });

  it('rejects undo after the short undo window', async () => {
    const tx = {
      orderItemUnit: {
        findFirst: async () => ({
          id: 'unit-1',
          orderItemId: 'item-1',
          status: 'READY',
          completedById: 'barista-id',
          completedAt: new Date(Date.now() - 20_000),
          startedById: 'barista-id',
          startedAt: new Date(Date.now() - 30_000),
          orderItem: { orderId: 'order-1' },
        }),
      },
    };
    const service = counterService({ $transaction: (callback) => callback(tx) });
    await assert.rejects(() => service.undoUnit(barista, 'unit-1'), /can no longer be undone/);
  });

  it('marks paid queued items out of stock when barista disables a menu item', async () => {
    let unitMutation;
    let itemMutation;
    const tx = {
      branchMenuItem: { updateMany: async () => ({ count: 1 }) },
      orderItem: {
        findMany: async () => [
          { id: 'line-1', orderId: 'order-1' },
          { id: 'line-2', orderId: 'order-1' },
        ],
        updateMany: async (args) => {
          itemMutation = args;
          return { count: 2 };
        },
      },
      orderItemUnit: {
        updateMany: async (args) => {
          unitMutation = args;
          return { count: 2 };
        },
      },
    };
    const service = counterService({ $transaction: (callback) => callback(tx) });
    const result = await service.setMenuItemAvailability(barista, 'drink-id', {
      isAvailable: false,
    });
    assert.deepEqual(result.affectedOrderIds, ['order-1']);
    assert.deepEqual(unitMutation.where.orderItemId.in, ['line-1', 'line-2']);
    assert.equal(unitMutation.data.status, 'OUT_OF_STOCK');
    assert.equal(itemMutation.data.status, 'OUT_OF_STOCK');
    assert.equal(itemMutation.data.unavailableById, 'barista-id');
  });
});
