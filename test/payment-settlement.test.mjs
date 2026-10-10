import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Prisma } from '../dist/generated/prisma/client.js';
import { CounterPaymentSettlementService } from '../dist/modules/payments/counter-payment-settlement.service.js';

const manager = {
  id: 'manager-user',
  role: 'MANAGER',
  employeeId: 'manager-employee',
  branchId: 'branch-id',
};

function fixture(overrides = {}) {
  const calls = { units: 0, printJobs: [], audits: [], events: [] };
  const payment = {
    id: 'payment-id',
    orderId: 'order-id',
    processedById: 'cashier-id',
    stationId: 'station-id',
    method: 'BANK_TRANSFER',
    status: 'PENDING',
    amount: new Prisma.Decimal(50_000),
    receivedAmount: null,
    providerTransactionId: null,
    transactionRef: 'link-id',
    order: {
      id: 'order-id',
      orderCode: 'ORD-1',
      branchId: 'branch-id',
      type: 'COUNTER_PICKUP',
      status: 'CONFIRMED',
      paymentStatus: 'UNPAID',
      items: [{ id: 'item-id', quantity: 2 }],
      branch: { timezone: 'Asia/Ho_Chi_Minh' },
    },
    ...overrides,
  };
  const tx = {
    $queryRaw: async () => [{ id: 'locked' }],
    payment: {
      findUnique: async () => payment,
      update: async ({ data }) => ({ ...payment, ...data, order: payment.order }),
    },
    order: {
      update: async ({ data }) => ({
        ...payment.order,
        ...data,
        callNumber: data.callNumber,
        submittedAt: data.submittedAt,
      }),
    },
    orderItem: {
      update: async () => {
        calls.units += 2;
        return {};
      },
    },
    branchDailySequence: { upsert: async () => ({ nextNumber: 23 }) },
    printJob: {
      createMany: async ({ data }) => {
        calls.printJobs.push(...data);
        return { count: data.length };
      },
    },
    branchAuditLog: {
      create: async ({ data }) => {
        calls.audits.push(data);
        return data;
      },
    },
  };
  const prisma = {
    $transaction: async (work) => work(tx),
  };
  const tracking = {
    ensureForOrder: async (_tx, orderId) => ({ token: 'token', url: `/t/${orderId}` }),
  };
  const realtime = {
    branch: (branchId, type, data) => calls.events.push({ branchId, type, data }),
    callingDisplay: (branchId, type, data) => calls.events.push({ branchId, type, data }),
  };
  return { service: new CounterPaymentSettlementService(prisma, tracking, realtime), calls };
}

describe('Counter payment settlement (#53 and #54)', () => {
  it('commits the complete post-payment workflow for manager confirmation', async () => {
    const { service, calls } = fixture();
    const result = await service.settle({
      paymentId: 'payment-id',
      source: 'MANAGER_MANUAL',
      receivedAmount: 60_000,
      transactionRef: 'manual-reference',
      actor: manager,
      reason: 'Đã kiểm tra tài khoản ngân hàng',
    });

    assert.equal(result.payment.status, 'SUCCESS');
    assert.equal(result.payment.receivedAmount.toString(), '60000');
    assert.equal(result.order.callNumber, 23);
    assert.equal(result.tracking.token, 'token');
    assert.equal(calls.units, 2);
    assert.deepEqual(
      calls.printJobs.map((job) => job.type),
      ['RECEIPT', 'QUEUE_TICKET'],
    );
    assert.equal(calls.audits[0].after.changeDue, '10000');
    assert.deepEqual(
      calls.events.map((event) => event.type),
      ['payment.confirmed', 'preparation.order.queued', 'calling.order.queued'],
    );
    assert.equal(calls.events[0].data.orderId, 'order-id');
    assert.equal(calls.events[0].data.callNumber, 23);
  });

  it('rejects an underpayment before changing the order', async () => {
    const { service, calls } = fixture();
    await assert.rejects(
      service.settle({
        paymentId: 'payment-id',
        source: 'MANAGER_MANUAL',
        receivedAmount: 49_999,
        actor: manager,
        reason: 'Đã kiểm tra tài khoản ngân hàng',
      }),
      (error) =>
        error?.getStatus?.() === 409 &&
        error?.getResponse?.().error === 'PAYMENT_AMOUNT_INSUFFICIENT',
    );
    assert.equal(calls.units, 0);
    assert.equal(calls.printJobs.length, 0);
    assert.equal(calls.events.length, 0);
  });

  it('rejects manual confirmation for cash', async () => {
    const { service } = fixture({ method: 'CASH' });
    await assert.rejects(
      service.settle({
        paymentId: 'payment-id',
        source: 'MANAGER_MANUAL',
        receivedAmount: 50_000,
        actor: manager,
        reason: 'Xác nhận tại quầy',
      }),
      (error) => error?.getStatus?.() === 409 && /bank transfers/.test(error.message),
    );
  });

  it('stores a mismatched amount and alerts the branch without queueing preparation', async () => {
    const { service, calls } = fixture();
    const result = await service.markAmountMismatch('payment-id', 40_000, 'payos-reference');
    assert.equal(result.status, 'AMOUNT_MISMATCH');
    assert.equal(result.receivedAmount.toString(), '40000');
    assert.equal(result.failureReason, null);
    assert.equal(calls.units, 0);
    assert.equal(calls.printJobs.length, 0);
    assert.equal(calls.events[0].type, 'manager.order.attention-required');
    assert.equal(calls.events[0].data.expectedAmount, '50000');
    assert.equal(calls.events[0].data.receivedAmount, '40000');
  });

  it('does not settle a payment twice', async () => {
    const { service } = fixture({ status: 'SUCCESS' });
    await assert.rejects(
      service.settle({
        paymentId: 'payment-id',
        source: 'PAYOS_RECHECK',
        receivedAmount: 50_000,
      }),
      (error) => error?.getStatus?.() === 409 && error.message === 'PAYMENT_ALREADY_SETTLED',
    );
  });
});
