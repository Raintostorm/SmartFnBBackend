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

describe('V8 counter operations', () => {
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
    const service = new CounterOperationsService({ $transaction: (callback) => callback(tx) });
    await assert.rejects(() => service.collectCash(cashier, 'order-id', { stationId: 'station-id', tenderedAmount: 40000 }), BadRequestException);
  });

  it('does not finalize an empty counter order', async () => {
    const service = new CounterOperationsService({
      order: {
        findFirst: async () => ({ id: 'order-id', status: 'PENDING', items: [] }),
      },
    });
    await assert.rejects(() => service.finalize(cashier, 'order-id'), BadRequestException);
  });

  it('does not finalize the same order twice', async () => {
    const service = new CounterOperationsService({
      order: {
        findFirst: async () => ({ id: 'order-id', status: 'CONFIRMED', items: [{ id: 'item-id' }] }),
      },
    });
    await assert.rejects(() => service.finalize(cashier, 'order-id'), ConflictException);
  });

  it('does not collect payment through a station outside the cashier branch', async () => {
    const { Prisma } = await import('../dist/generated/prisma/client.js');
    const service = new CounterOperationsService({
      $transaction: (callback) => callback({
        order: {
          findFirst: async () => ({
            id: 'order-id', status: 'CONFIRMED', paymentStatus: 'UNPAID',
            totalAmount: new Prisma.Decimal(50000), items: [{ id: 'item-id', quantity: 1 }],
          }),
        },
        posStation: { findFirst: async () => null },
      }),
    });
    await assert.rejects(
      () => service.collectCash(cashier, 'order-id', { stationId: 'foreign-station', tenderedAmount: 50000 }),
      /Active POS station was not found in your branch/,
    );
  });

  it('cancels only an unpaid confirmed order and records the cashier and reason', async () => {
    let mutation;
    const service = new CounterOperationsService({
      order: { updateMany: async (args) => { mutation = args; return { count: 1 }; } },
    });
    assert.deepEqual(await service.cancelUnpaid(cashier, 'order-id', 'Khách đổi món'), { cancelled: true });
    assert.equal(mutation.where.branchId, 'branch-id');
    assert.equal(mutation.where.status, 'CONFIRMED');
    assert.equal(mutation.where.paymentStatus, 'UNPAID');
    assert.equal(mutation.data.cancelledById, 'cashier-id');
    assert.equal(mutation.data.cancellationReason, 'Khách đổi món');
  });

  it('rechecks and atomically reserves limited portions before taking cash', async () => {
    const { Prisma } = await import('../dist/generated/prisma/client.js');
    const tx = {
      order: {
        findFirst: async () => ({
          id: 'order-id', status: 'CONFIRMED', paymentStatus: 'UNPAID',
          totalAmount: new Prisma.Decimal(50000),
          items: [{ id: 'line-1', menuItemId: 'drink-id', quantity: 2 }],
        }),
      },
      posStation: { findFirst: async () => ({ id: 'station-id' }) },
      branchMenuItem: {
        findUnique: async () => ({ isEnabled: true, isAvailable: true, remainingPortions: 1 }),
        updateMany: async () => ({ count: 0 }),
      },
    };
    const service = new CounterOperationsService({ $transaction: (callback) => callback(tx) });
    await assert.rejects(
      () => service.collectCash(cashier, 'order-id', { stationId: 'station-id', tenderedAmount: 50000 }),
      /Not enough portions remain/,
    );
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
        menuItem: { categoryId: 'drinks' },
        itemName: 'Trà sữa',
        selectedOptions: [{ groupCode: 'SIZE', groupName: 'Size', name: size }],
        specialInstructions: null,
        order: { callNumber, paidAt: new Date(paidAt.getTime() + offsetMinutes * 60_000) },
      },
    });
    const service = new CounterOperationsService({
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
    assert.deepEqual(batches[0].units.map((unit) => unit.id), ['oldest', 'same-size']);
    assert.equal(batches[1].size, 'M');
    assert.equal(batches[2].units[0].id, 'outside-window');
  });
});
