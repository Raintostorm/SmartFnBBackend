import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../dist/generated/prisma/client.js';
import { StationsService } from '../dist/modules/counter-operations/stations.service.js';

const cashier = {
  id: 'user-id',
  email: 'cashier@example.com',
  role: 'CASHIER',
  sessionId: 'session-id',
  employeeId: 'cashier-id',
  branchId: 'branch-a',
  ownerId: null,
  chainId: null,
  chainIds: [],
};
const writableBranch = { assertSubscriptionAllowsWrite: async () => undefined };
const stationsService = (prisma, branchAccess = writableBranch, realtime) =>
  new StationsService(prisma, branchAccess, realtime);
const activeDevice = (overrides = {}) => ({
  id: 'device-id',
  branchId: 'branch-a',
  stationId: null,
  revokedAt: null,
  tokenExpiresAt: new Date(Date.now() + 60_000),
  ...overrides,
});

describe('V9 POS stations and display pairing', () => {
  it('creates a device token for the screen and stores only its hash', async () => {
    let data;
    const service = stationsService({
      pairingCode: {
        create: async (args) => {
          data = args.data;
          return { id: 'pairing-id', expiresAt: args.data.expiresAt };
        },
      },
    });
    const result = await service.createPairingCode('CUSTOMER_DISPLAY');
    assert.equal(result.code.length, 6);
    assert.ok(result.deviceToken.length >= 32);
    assert.equal(data.deviceTokenHash.length, 64);
    assert.notEqual(data.deviceTokenHash, result.deviceToken);
  });

  it('cleans stale pairing codes and limits public code creation per client', async () => {
    let cleanups = 0;
    const service = stationsService({
      pairingCode: {
        deleteMany: async () => {
          cleanups += 1;
          return { count: 0 };
        },
        create: async ({ data }) => ({ id: `pairing-${cleanups}`, expiresAt: data.expiresAt }),
      },
    });
    for (let index = 0; index < 10; index += 1)
      await service.createPairingCode('CUSTOMER_DISPLAY', '203.0.113.10');
    await assert.rejects(
      () => service.createPairingCode('CUSTOMER_DISPLAY', '203.0.113.10'),
      (error) => error?.getStatus?.() === 429,
    );
    assert.equal(cleanups, 10);
  });

  it('returns a stable 409 code when a station name already exists', async () => {
    const duplicate = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: '7.10.0',
      meta: { target: ['branch_id', 'name'] },
    });
    const service = stationsService({
      posStation: { create: async () => Promise.reject(duplicate) },
    });
    await assert.rejects(
      () => service.create(cashier, { name: 'Quầy 1' }),
      (error) =>
        error instanceof ConflictException &&
        error.getResponse().code === 'STATION_NAME_ALREADY_EXISTS',
    );
  });

  it('requires an employee assigned to a branch', () => {
    const service = stationsService({});
    assert.throws(
      () => service.list({ ...cashier, employeeId: null, branchId: null }),
      ForbiddenException,
    );
  });

  it('always scopes station listing to the authenticated branch', async () => {
    let query;
    const service = stationsService({
      posStation: {
        findMany: async (args) => {
          query = args;
          return [];
        },
      },
    });
    await service.list(cashier);
    assert.equal(query.where.branchId, 'branch-a');
  });

  it('updates only a station in the manager branch', async () => {
    let update;
    const service = stationsService({
      posStation: {
        findFirst: async ({ where }) => {
          assert.deepEqual(where, { id: 'station-a', branchId: 'branch-a' });
          return { id: 'station-a', printerConnection: 'NONE', printerAddress: null };
        },
        update: async (args) => {
          update = args;
          return { id: 'station-a', ...args.data };
        },
      },
    });
    const result = await service.update(cashier, 'station-a', {
      name: ' Quầy mang đi ',
      status: 'INACTIVE',
    });
    assert.equal(result.name, 'Quầy mang đi');
    assert.equal(update.data.status, 'INACTIVE');
  });

  it('rejects a station outside the cashier branch', async () => {
    const service = stationsService({
      $transaction: (callback) => callback({ posStation: { findFirst: async () => null } }),
    });
    await assert.rejects(
      () => service.pairCustomerDisplay(cashier, 'station-b', '123456'),
      NotFoundException,
    );
  });

  it('rejects an expired pairing code before creating a device', async () => {
    let deviceCreated = false;
    const tx = {
      posStation: { findFirst: async () => ({ id: 'station-a' }) },
      pairingCode: {
        findUnique: async () => ({
          id: 'pairing-id',
          deviceType: 'CUSTOMER_DISPLAY',
          consumedAt: null,
          expiresAt: new Date(Date.now() - 1_000),
        }),
      },
      displayDevice: {
        updateMany: async () => ({ count: 0 }),
        create: async () => {
          deviceCreated = true;
          return { id: 'device-id' };
        },
      },
    };
    const service = stationsService({ $transaction: (callback) => callback(tx) });
    await assert.rejects(
      () => service.pairCustomerDisplay(cashier, 'station-a', '123456'),
      BadRequestException,
    );
    assert.equal(deviceCreated, false);
  });

  it('revokes only an active device from the authenticated branch', async () => {
    let query;
    let disconnected;
    const service = stationsService(
      {
        displayDevice: {
          updateMany: async (args) => {
            query = args;
            return { count: 1 };
          },
        },
      },
      writableBranch,
      {
        revokeDevice: async (id) => {
          disconnected = id;
        },
      },
    );
    assert.deepEqual(await service.revoke(cashier, 'device-id'), { revoked: true });
    assert.deepEqual(query.where, { id: 'device-id', branchId: 'branch-a', revokedAt: null });
    assert.equal(disconnected, 'device-id');
  });

  it('pairs one calling display for the manager branch without returning its token', async () => {
    let created;
    const tx = {
      pairingCode: {
        findUnique: async () => ({
          id: 'pairing-id',
          deviceType: 'CALLING_DISPLAY',
          deviceTokenHash: 'a'.repeat(64),
          consumedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
        }),
        updateMany: async () => ({ count: 1 }),
      },
      displayDevice: {
        updateMany: async () => ({ count: 1 }),
        create: async ({ data }) => {
          created = data;
          return { id: 'calling-device' };
        },
      },
    };
    const service = stationsService({ $transaction: (callback) => callback(tx) });
    const result = await service.pairCallingDisplay(cashier, '123456', 'TV nhận món');
    assert.equal(created.type, 'CALLING_DISPLAY');
    assert.equal(created.branchId, 'branch-a');
    assert.equal(created.stationId, undefined);
    assert.equal(result.deviceToken, undefined);
  });

  it('returns only ready paid orders for a valid calling-display token', async () => {
    let orderFilter;
    const service = stationsService({
      displayDevice: {
        findFirst: async () => activeDevice(),
        update: async () => ({}),
      },
      order: {
        findMany: async ({ where }) => {
          orderFilter = where;
          return [{ callNumber: 23 }];
        },
      },
    });
    const result = await service.callingDisplayReadyOrders('Bearer valid-device-token');
    assert.equal(result[0].callNumber, 23);
    assert.equal(orderFilter.branchId, 'branch-a');
    assert.equal(orderFilter.paymentStatus, 'PAID');
    assert.equal(orderFilter.status, 'READY');
  });

  it('returns separate current-day preparing and ready columns with branding', async () => {
    const queries = [];
    const service = stationsService({
      displayDevice: {
        findFirst: async () => activeDevice(),
        update: async () => ({}),
      },
      branch: {
        findUniqueOrThrow: async () => ({
          name: 'Q1',
          timezone: 'Asia/Ho_Chi_Minh',
          chain: {
            name: 'Smart Cafe',
            logoUrl: null,
            branding: { displayName: 'Cafe', logoUrl: null, primaryColor: '#111111' },
          },
        }),
      },
      order: {
        findMany: (args) => {
          queries.push(args);
          return args;
        },
        count: (args) => args,
      },
      $transaction: async (items) => {
        assert.equal(items.length, 4);
        return [
          [{ callNumber: 21, status: 'PREPARING' }],
          [{ callNumber: 23, status: 'READY' }],
          42,
          7,
        ];
      },
    });
    const result = await service.callingDisplayContext('Bearer valid-device-token');
    assert.equal(result.branding.displayName, 'Cafe');
    assert.equal(result.preparing[0].callNumber, 21);
    assert.equal(result.ready[0].callNumber, 23);
    assert.deepEqual(result.counts, { preparing: 42, ready: 7 });
    assert.equal(result.pageLimit, 30);
    assert.deepEqual(queries[0].where.status.in, ['SUBMITTED', 'PREPARING']);
    assert.equal(queries[1].where.status, 'READY');
    assert.ok(queries[0].where.businessDate instanceof Date);
  });

  it('rejects a revoked or invalid calling-display token', async () => {
    const service = stationsService({
      displayDevice: { findFirst: async () => null },
    });
    await assert.rejects(
      service.callingDisplayReadyOrders('Bearer invalid-token'),
      ForbiddenException,
    );
  });

  it('returns a distinct error for an expired display token', async () => {
    const service = stationsService({
      displayDevice: {
        findFirst: async () => activeDevice({ tokenExpiresAt: new Date(Date.now() - 1_000) }),
      },
    });
    await assert.rejects(
      service.callingDisplayReadyOrders('Bearer expired-token'),
      (error) =>
        error instanceof ForbiddenException && error.getResponse().code === 'DEVICE_TOKEN_EXPIRED',
    );
  });

  it('restores the latest cart and branding for a paired customer display', async () => {
    const service = stationsService({
      displayDevice: {
        findFirst: async () => activeDevice({ stationId: 'station-a' }),
        update: async () => ({}),
      },
      posStation: {
        findFirst: async () => ({
          id: 'station-a',
          name: 'Quầy 1',
          cartVersion: 4,
          cartSnapshot: { state: 'CART', items: [], totalAmount: 50000 },
          branch: {
            id: 'branch-a',
            name: 'Chi nhánh A',
            chain: { name: 'Smart Cafe', logoUrl: null, currency: 'VND', branding: null },
          },
        }),
      },
    });
    const result = await service.customerDisplayContext('Bearer display-token');
    assert.equal(result.station.id, 'station-a');
    assert.equal(result.version, 4);
    assert.equal(result.snapshot.totalAmount, 50000);
    assert.equal(result.branding.displayName, 'Smart Cafe');
  });
});
