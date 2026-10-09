import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GoneException, NotFoundException } from '@nestjs/common';
import { OrderTrackingService } from '../dist/modules/order-tracking/order-tracking.service.js';

const config = {
  get(key) {
    if (key === 'ORDER_TRACKING_SECRET')
      return 'test-secret-that-is-longer-than-thirty-two-characters';
    if (key === 'PUBLIC_WEB_URL') return 'https://web.example.com/';
  },
};

describe('Public pickup tracking', () => {
  it('stores only a token hash and can rebuild the same public URL', async () => {
    let stored;
    const record = {
      id: 'tracking-id',
      orderId: 'order-id',
      tokenSalt: 'salt',
      tokenHash: '',
      expiresAt: new Date(Date.now() + 60_000),
    };
    const prisma = {
      orderTrackingToken: {
        findUnique: async () => (stored ? { ...record, ...stored } : null),
        create: async ({ data }) => {
          stored = data;
          return { ...record, ...data };
        },
      },
    };
    const service = new OrderTrackingService(prisma, config);
    const first = await service.ensureForOrder(prisma, 'order-id');
    const second = await service.presentationForOrder('order-id');
    assert.equal(first.url, second.url);
    assert.ok(first.token.length >= 43);
    assert.notEqual(stored.tokenHash, first.token);
    assert.equal(stored.tokenHash.length, 64);
  });

  it('returns only pickup-safe fields for a valid token', async () => {
    let tokenHash;
    const prisma = {
      orderTrackingToken: {
        findUnique: async ({ where }) => {
          if (where.orderId) return null;
          if (where.tokenHash !== tokenHash) return null;
          return {
            id: 'tracking-id',
            expiresAt: new Date(Date.now() + 60_000),
            terminalAt: null,
            revokedAt: null,
            order: {
              status: 'READY',
              paymentStatus: 'PAID',
              callNumber: 23,
              readyAt: new Date(),
              deliveredAt: null,
              cancelledAt: null,
              updatedAt: new Date(),
              branch: {
                name: 'Q1',
                chain: { name: 'Smart Cafe', logoUrl: null, branding: null },
              },
            },
          };
        },
        create: async ({ data }) => {
          tokenHash = data.tokenHash;
          return { ...data, id: 'tracking-id' };
        },
        update: async () => ({}),
      },
    };
    const service = new OrderTrackingService(prisma, config);
    const { token } = await service.ensureForOrder(prisma, 'order-id');
    const result = await service.track(token, '127.0.0.1');
    assert.equal(result.callNumber, 23);
    assert.equal(result.displayStatus, 'READY_FOR_PICKUP');
    assert.equal(result.branch.name, 'Q1');
    assert.equal('items' in result, false);
    assert.equal('totalAmount' in result, false);
  });

  it('rejects malformed and expired tokens', async () => {
    const missing = new OrderTrackingService(
      { orderTrackingToken: { findUnique: async () => null } },
      config,
    );
    await assert.rejects(() => missing.track('bad', 'ip'), NotFoundException);

    const expired = new OrderTrackingService(
      {
        orderTrackingToken: {
          findUnique: async () => ({
            expiresAt: new Date(Date.now() - 1),
            revokedAt: null,
            terminalAt: null,
          }),
        },
      },
      config,
    );
    await assert.rejects(() => expired.track('a'.repeat(43), 'ip'), GoneException);
  });
});
