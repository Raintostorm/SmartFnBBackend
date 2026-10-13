import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PaymentExpiryWorker } from '../dist/modules/payments/payment-expiry.worker.js';

describe('PayOS payment expiry worker', () => {
  it('expires each due payment in a bounded batch', async () => {
    let query;
    const expired = [];
    const worker = new PaymentExpiryWorker(
      {
        payment: {
          findMany: async (args) => {
            query = args;
            return [{ id: 'p1' }, { id: 'p2' }];
          },
        },
      },
      { markExpired: async (id) => expired.push(id) },
      { get: (name, fallback) => (name === 'PAYMENT_EXPIRY_BATCH_SIZE' ? 25 : fallback) },
    );
    assert.equal(await worker.runOnce(), 2);
    assert.deepEqual(expired, ['p1', 'p2']);
    assert.equal(query.take, 25);
    assert.equal(query.where.provider, 'PAYOS');
    assert.equal(query.where.status, 'PENDING');
    assert.ok(query.where.expiresAt.lte instanceof Date);
  });
});
