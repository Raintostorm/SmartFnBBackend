import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PayosReconciliationWorker } from '../dist/modules/payos/payos-reconciliation.worker.js';

describe('PayOS reconciliation worker', () => {
  it('rechecks recent pending payments in a bounded batch', async () => {
    let query;
    const checked = [];
    const worker = new PayosReconciliationWorker(
      {
        payment: {
          findMany: async (args) => {
            query = args;
            return [{ id: 'pending-1' }, { id: 'pending-2' }];
          },
        },
      },
      {
        reconcilePending: async (id) => {
          checked.push(id);
          return { status: id === 'pending-1' ? 'SUCCESS' : 'PENDING' };
        },
      },
      {
        get: (name, fallback) => {
          if (name === 'PAYOS_RECONCILIATION_LOOKBACK_MS') return 900_000;
          if (name === 'PAYOS_RECONCILIATION_BATCH_SIZE') return 12;
          return fallback;
        },
      },
    );

    assert.equal(await worker.runOnce(), 1);
    assert.deepEqual(checked, ['pending-1', 'pending-2']);
    assert.equal(query.take, 12);
    assert.equal(query.where.provider, 'PAYOS');
    assert.equal(query.where.status, 'PENDING');
    assert.ok(query.where.createdAt.gte instanceof Date);
    assert.ok(query.where.OR[1].expiresAt.gt instanceof Date);
  });

  it('keeps processing the batch when one PayOS request fails', async () => {
    const checked = [];
    const worker = new PayosReconciliationWorker(
      { payment: { findMany: async () => [{ id: 'bad' }, { id: 'good' }] } },
      {
        reconcilePending: async (id) => {
          checked.push(id);
          if (id === 'bad') throw new Error('temporary PayOS failure');
          return { status: 'SUCCESS' };
        },
      },
      { get: (_name, fallback) => fallback },
    );

    assert.equal(await worker.runOnce(), 1);
    assert.deepEqual(checked, ['bad', 'good']);
  });
});
