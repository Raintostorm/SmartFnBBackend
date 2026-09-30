import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { StationsService } from '../dist/modules/counter-operations/stations.service.js';

const cashier = {
  id: 'user-id', email: 'cashier@example.com', role: 'CASHIER', sessionId: 'session-id',
  employeeId: 'cashier-id', branchId: 'branch-a', ownerId: null, chainId: null, chainIds: [],
};

describe('V9 POS stations and display pairing', () => {
  it('requires an employee assigned to a branch', () => {
    const service = new StationsService({});
    assert.throws(() => service.list({ ...cashier, employeeId: null, branchId: null }), ForbiddenException);
  });

  it('always scopes station listing to the authenticated branch', async () => {
    let query;
    const service = new StationsService({
      posStation: { findMany: async (args) => { query = args; return []; } },
    });
    await service.list(cashier);
    assert.equal(query.where.branchId, 'branch-a');
  });

  it('rejects a station outside the cashier branch', async () => {
    const service = new StationsService({
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
    const service = new StationsService({ $transaction: (callback) => callback(tx) });
    await assert.rejects(() => service.pairCustomerDisplay(cashier, 'station-a', '123456'), BadRequestException);
    assert.equal(deviceCreated, false);
  });

  it('revokes only an active device from the authenticated branch', async () => {
    let query;
    const service = new StationsService({
      displayDevice: { updateMany: async (args) => { query = args; return { count: 1 }; } },
    });
    assert.deepEqual(await service.revoke(cashier, 'device-id'), { revoked: true });
    assert.deepEqual(query.where, { id: 'device-id', branchId: 'branch-a', revokedAt: null });
  });
});
