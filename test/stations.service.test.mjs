import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { StationsService } from '../dist/modules/counter-operations/stations.service.js';

const cashier = {
  id: 'user-id', email: 'cashier@example.com', role: 'CASHIER', sessionId: 'session-id',
  employeeId: 'cashier-id', branchId: 'branch-a', ownerId: null, chainId: null, chainIds: [],
};
const writableBranch = { assertSubscriptionAllowsWrite: async () => undefined };
const stationsService = (prisma, branchAccess = writableBranch) =>
  new StationsService(prisma, branchAccess);

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

  it('requires an employee assigned to a branch', () => {
    const service = stationsService({});
    assert.throws(() => service.list({ ...cashier, employeeId: null, branchId: null }), ForbiddenException);
  });

  it('always scopes station listing to the authenticated branch', async () => {
    let query;
    const service = stationsService({
      posStation: { findMany: async (args) => { query = args; return []; } },
    });
    await service.list(cashier);
    assert.equal(query.where.branchId, 'branch-a');
  });

  it('rejects a station outside the cashier branch', async () => {
    const service = stationsService({
      $transaction: (callback) => callback({ posStation: { findFirst: async () => null } }),
    });
    await assert.rejects(() => service.pairCustomerDisplay(cashier, 'station-b', '123456'), NotFoundException);
  });

  it('rejects an expired pairing code before creating a device', async () => {
    let deviceCreated = false;
    const tx = {
      posStation: { findFirst: async () => ({ id: 'station-a' }) },
      pairingCode: {
        findUnique: async () => ({
          id: 'pairing-id', deviceType: 'CUSTOMER_DISPLAY', consumedAt: null,
          expiresAt: new Date(Date.now() - 1_000),
        }),
      },
      displayDevice: {
        updateMany: async () => ({ count: 0 }),
        create: async () => { deviceCreated = true; return { id: 'device-id' }; },
      },
    };
    const service = stationsService({ $transaction: (callback) => callback(tx) });
    await assert.rejects(() => service.pairCustomerDisplay(cashier, 'station-a', '123456'), BadRequestException);
    assert.equal(deviceCreated, false);
  });

  it('revokes only an active device from the authenticated branch', async () => {
    let query;
    const service = stationsService({
      displayDevice: { updateMany: async (args) => { query = args; return { count: 1 }; } },
    });
    assert.deepEqual(await service.revoke(cashier, 'device-id'), { revoked: true });
    assert.deepEqual(query.where, { id: 'device-id', branchId: 'branch-a', revokedAt: null });
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
        create: async ({ data }) => { created = data; return { id: 'calling-device' }; },
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
        findFirst: async () => ({ id: 'device-id', branchId: 'branch-a', stationId: null }),
        update: async () => ({}),
      },
      order: {
        findMany: async ({ where }) => { orderFilter = where; return [{ callNumber: 23 }]; },
      },
    });
    const result = await service.callingDisplayReadyOrders('Bearer valid-device-token');
    assert.equal(result[0].callNumber, 23);
    assert.equal(orderFilter.branchId, 'branch-a');
    assert.equal(orderFilter.paymentStatus, 'PAID');
    assert.equal(orderFilter.status, 'READY');
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
});
