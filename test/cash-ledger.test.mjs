import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Prisma } from '../dist/generated/prisma/client.js';
import { CashLedgerService } from '../dist/modules/payments/cash-ledger.service.js';

describe('Append-only cash ledger (BR-94)', () => {
  it('writes one idempotent inflow per payment and one outflow per refund', async () => {
    const calls = [];
    const tx = {
      cashLedgerEntry: {
        createMany: async (args) => {
          calls.push(args);
          return { count: 1 };
        },
      },
    };
    const service = new CashLedgerService({}, {});
    await service.recordSale(tx, {
      branchId: 'branch',
      chainId: 'chain',
      orderId: 'order',
      paymentId: 'payment',
      amount: new Prisma.Decimal(50_000),
      method: 'CASH',
      source: 'CASH_PAYMENT',
      occurredAt: new Date(),
    });
    await service.recordRefund(tx, {
      branchId: 'branch',
      chainId: 'chain',
      orderId: 'order',
      paymentId: 'payment',
      refundId: 'refund',
      amount: new Prisma.Decimal(20_000),
      method: 'CASH',
      occurredAt: new Date(),
    });
    assert.equal(calls[0].skipDuplicates, true);
    assert.deepEqual(
      { sourceType: calls[0].data[0].sourceType, sourceId: calls[0].data[0].sourceId },
      { sourceType: 'CASH_PAYMENT', sourceId: 'payment' },
    );
    assert.equal(calls[0].data[0].direction, 'INFLOW');
    assert.deepEqual(
      { sourceType: calls[1].data[0].sourceType, sourceId: calls[1].data[0].sourceId },
      { sourceType: 'REFUND', sourceId: 'refund' },
    );
    assert.equal(calls[1].data[0].direction, 'OUTFLOW');
  });

  it('enforces branch scope and Owner chain assignment on reads', async () => {
    let branchChecked;
    const prisma = {
      ownerChainAssignment: { count: async ({ where }) => (where.chainId === 'chain' ? 1 : 0) },
      cashLedgerEntry: { findMany: async () => [], groupBy: async () => [] },
      $transaction: async (items) => Promise.all(items),
    };
    const service = new CashLedgerService(prisma, {
      assertCanAccessBranch: async (_user, id) => {
        branchChecked = id;
      },
    });
    await service.listBranch({ role: 'MANAGER' }, 'branch');
    assert.equal(branchChecked, 'branch');
    await service.listChain({ role: 'OWNER', ownerId: 'owner' }, 'chain');
    await assert.rejects(
      service.listChain({ role: 'MANAGER' }, 'chain'),
      (error) => error.getStatus() === 403,
    );
  });
});
