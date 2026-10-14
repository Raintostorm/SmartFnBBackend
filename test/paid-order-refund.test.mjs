import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Prisma } from '../dist/generated/prisma/client.js';
import { PaidOrderRefundService } from '../dist/modules/payments/paid-order-refund.service.js';

const manager = {
  id: '11111111-1111-4111-8111-111111111111',
  role: 'MANAGER',
  employeeId: '22222222-2222-4222-8222-222222222222',
  branchId: '33333333-3333-4333-8333-333333333333',
};
const owner = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  role: 'OWNER',
  ownerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  employeeId: null,
  branchId: null,
};

function fixture({
  paymentStatus = 'SUCCESS',
  orderStatus = 'SUBMITTED',
  receivedAmount = 50_000,
  failureReason = null,
} = {}) {
  const calls = {
    audits: [],
    events: [],
    refundCreates: [],
    printJobs: [],
    itemUpdates: [],
    paymentUpdates: [],
  };
  const payment = {
    id: '44444444-4444-4444-8444-444444444444',
    orderId: '55555555-5555-4555-8555-555555555555',
    status: paymentStatus,
    amount: new Prisma.Decimal(50_000),
    receivedAmount: new Prisma.Decimal(receivedAmount),
    providerTransactionId: null,
    failureReason,
  };
  const items = [
    {
      id: '66666666-6666-4666-8666-666666666666',
      menuItemId: '77777777-7777-4777-8777-777777777777',
      itemName: 'Trà sữa',
      quantity: 1,
      totalPrice: new Prisma.Decimal(30_000),
      status: 'QUEUED',
      units: [{ id: 'unit-1', status: 'QUEUED' }],
      refundItems: [],
    },
    {
      id: '88888888-8888-4888-8888-888888888888',
      menuItemId: '99999999-9999-4999-8999-999999999999',
      itemName: 'Cà phê',
      quantity: 1,
      totalPrice: new Prisma.Decimal(20_000),
      status: 'READY',
      units: [{ id: 'unit-2', status: 'READY' }],
      refundItems: [],
    },
  ];
  const order = {
    id: payment.orderId,
    branchId: manager.branchId,
    type: 'COUNTER_PICKUP',
    status: orderStatus,
    paymentStatus: paymentStatus === 'SUCCESS' ? 'PAID' : 'UNPAID',
    totalAmount: new Prisma.Decimal(50_000),
    branch: { timezone: 'Asia/Ho_Chi_Minh' },
    items,
    refunds: [],
  };
  let currentOrderStatus = order.status;
  const tx = {
    $queryRaw: async () => [],
    payment: {
      findFirst: async () => ({ id: payment.id }),
      findUnique: async () => ({ ...payment, order: { ...order, status: currentOrderStatus } }),
      findUniqueOrThrow: async () => payment,
      update: async ({ data }) => {
        calls.paymentUpdates.push(data);
        Object.assign(payment, data);
        return payment;
      },
    },
    order: {
      findFirst: async () => ({ ...order, status: currentOrderStatus }),
      update: async ({ data }) => {
        currentOrderStatus = data.status;
        return { ...order, ...data };
      },
    },
    orderItemUnit: { updateMany: async () => ({ count: 1 }) },
    orderItem: {
      update: async ({ where, data }) => {
        calls.itemUpdates.push({ id: where.id, ...data });
        return data;
      },
    },
    branchMenuItem: { updateMany: async () => ({ count: 1 }) },
    printJob: {
      updateMany: async (input) => {
        calls.printJobs.push(input);
        return { count: 1 };
      },
    },
    refund: {
      findUnique: async () => null,
      create: async ({ data }) => {
        calls.refundCreates.push(data);
        return {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          ...data,
          items: (data.items?.create ?? []).map((item, index) => ({
            id: `refund-item-${index}`,
            ...item,
          })),
        };
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
    refund: {
      findUnique: async () => ({ order: { branchId: manager.branchId } }),
    },
    ownerChainAssignment: { count: async () => 1 },
  };
  const realtime = {
    branch: (branchId, type, data) => calls.events.push({ branchId, type, data }),
    callingDisplay: (branchId, type, data) =>
      calls.events.push({ branchId, type: `calling:${type}`, data }),
  };
  return {
    service: new PaidOrderRefundService(prisma, realtime),
    calls,
    order,
    payment,
    tx,
  };
}

describe('Paid order cancellation and external refunds (#43)', () => {
  it('lists pending refunds only inside the Owner branch scope', async () => {
    let capturedWhere;
    const service = new PaidOrderRefundService(
      {
        refund: {
          findMany: async ({ where }) => {
            capturedWhere = where;
            return [{ id: 'refund-one' }];
          },
          count: async () => 1,
        },
        $transaction: async (queries) => Promise.all(queries),
      },
      {},
      { getAccessibleBranchIds: async () => [manager.branchId] },
    );
    const result = await service.listRefunds(owner, {
      chainId: '44444444-4444-4444-8444-444444444444',
      page: 1,
      limit: 20,
    });
    assert.equal(result.total, 1);
    assert.deepEqual(capturedWhere.order.branchId.in, [manager.branchId]);
    assert.equal(capturedWhere.status, 'PENDING');
    assert.equal(capturedWhere.order.branch.chainId, '44444444-4444-4444-8444-444444444444');

    await assert.rejects(
      service.listRefunds(owner, {
        branchIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
        page: 1,
        limit: 20,
      }),
      (error) => error?.getStatus?.() === 403,
    );
  });

  it('cancels a paid cash order, completes its refund and removes pending print jobs', async () => {
    const { service, calls, order } = fixture();
    const result = await service.cancelPaidOrder(manager, order.id, {
      reason: 'Khách đổi ý',
      refundMethod: 'CASH',
    });
    assert.equal(result.order.status, 'CANCELLED');
    assert.equal(result.refund.status, 'COMPLETED');
    assert.equal(result.refund.amount.toString(), '50000');
    assert.equal(calls.itemUpdates.length, 2);
    assert.equal(calls.printJobs.length, 1);
    assert.equal(calls.audits[0].action, 'PAID_ORDER_CANCELLED');
    assert.deepEqual(
      calls.events.map((event) => event.type),
      ['order.cancelled', 'calling:order.cancelled'],
    );
  });

  it('turns an underpaid mismatch into one pending refund for the amount actually received', async () => {
    const { service, calls, order } = fixture({
      paymentStatus: 'AMOUNT_MISMATCH',
      orderStatus: 'REQUIRES_ATTENTION',
      receivedAmount: 40_000,
    });
    const result = await service.cancelPaidOrder(manager, order.id, {
      reason: 'Khách chuyển thiếu và không thanh toán tiếp',
      refundMethod: 'BANK_TRANSFER',
    });
    assert.equal(result.order.status, 'CANCELLED');
    assert.equal(result.refund.status, 'PENDING');
    assert.equal(result.refund.amount.toString(), '40000');
    assert.deepEqual(
      calls.events.map((event) => event.type),
      ['order.cancelled', 'calling:order.cancelled', 'refund.pending'],
    );
  });

  it('cancels a late expired payment and refunds the amount actually received', async () => {
    const { service, calls, order } = fixture({
      paymentStatus: 'REQUIRES_ATTENTION',
      orderStatus: 'REQUIRES_ATTENTION',
      receivedAmount: 45_000,
      failureReason: 'PAYMENT_RECEIVED_AFTER_EXPIRY',
    });
    const result = await service.cancelPaidOrder(manager, order.id, {
      reason: 'Khách không tiếp tục đơn sau khi chuyển tiền muộn',
      refundMethod: 'BANK_TRANSFER',
    });
    assert.equal(result.order.status, 'CANCELLED');
    assert.equal(result.refund.status, 'PENDING');
    assert.equal(result.refund.amount.toString(), '45000');
    assert.equal(calls.refundCreates.length, 1);
  });

  it('cancels one line, keeps the remaining order active and records prepared waste', async () => {
    const { service, calls, order } = fixture({ orderStatus: 'READY' });
    const result = await service.cancelPaidOrder(manager, order.id, {
      reason: 'Khách không nhận món đã pha',
      refundMethod: 'CASH',
      orderItemIds: [order.items[1].id],
    });
    assert.equal(result.order.status, 'SUBMITTED');
    assert.equal(result.fullCancellation, false);
    assert.equal(result.refund.amount.toString(), '20000');
    assert.equal(result.refund.items[0].isWastage, true);
    assert.equal(calls.printJobs.length, 0);
  });

  it('rejects delivered orders without creating a refund', async () => {
    const { service, calls, order } = fixture({ orderStatus: 'DELIVERED' });
    await assert.rejects(
      service.cancelPaidOrder(manager, order.id, {
        reason: 'Yêu cầu quá muộn',
        refundMethod: 'CASH',
      }),
      (error) => error?.getStatus?.() === 409,
    );
    assert.equal(calls.refundCreates.length, 0);
  });

  it('does not create a second refund when cancellation is repeated', async () => {
    const { service, calls, order } = fixture();
    const request = { reason: 'Khách đổi ý', refundMethod: 'CASH' };
    await service.cancelPaidOrder(manager, order.id, request);
    await assert.rejects(
      service.cancelPaidOrder(manager, order.id, request),
      (error) => error?.getStatus?.() === 409,
    );
    assert.equal(calls.refundCreates.length, 1);
  });

  it('rejects Cashier and Barista before touching the database', async () => {
    for (const role of ['CASHIER', 'BARISTA']) {
      const { service, calls, order } = fixture();
      await assert.rejects(
        service.cancelPaidOrder({ ...manager, role }, order.id, {
          reason: 'Không đủ quyền',
          refundMethod: 'CASH',
        }),
        (error) => error?.getStatus?.() === 403,
      );
      assert.equal(calls.refundCreates.length, 0);
    }
  });

  it('completes a pending bank refund exactly once', async () => {
    const { service, calls, tx, order } = fixture();
    let status = 'PENDING';
    tx.refund.findUnique = async () => ({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      orderId: order.id,
      amount: new Prisma.Decimal(50_000),
      status,
      method: 'BANK_TRANSFER',
      order: { branchId: manager.branchId },
      items: [],
    });
    tx.refund.update = async ({ data }) => {
      status = data.status;
      return {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        orderId: order.id,
        amount: new Prisma.Decimal(50_000),
        method: 'BANK_TRANSFER',
        items: [],
        ...data,
      };
    };
    const result = await service.completeRefund(manager, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
      note: 'Đã chuyển cho khách',
    });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(calls.events.at(-1).type, 'refund.completed');
    await assert.rejects(
      service.completeRefund(manager, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {}),
      (error) => error?.getStatus?.() === 409,
    );
  });

  it('allows the chain Owner to complete a pending refund without an employee profile', async () => {
    const { service, tx, order } = fixture();
    tx.refund.findUnique = async () => ({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      orderId: order.id,
      amount: new Prisma.Decimal(50_000),
      status: 'PENDING',
      method: 'BANK_TRANSFER',
      order: { branchId: manager.branchId },
      items: [],
    });
    tx.refund.update = async ({ data }) => ({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      orderId: order.id,
      amount: new Prisma.Decimal(50_000),
      method: 'BANK_TRANSFER',
      items: [],
      ...data,
    });
    const result = await service.completeRefund(owner, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {});
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.completedByRole, 'OWNER');
    assert.equal(result.completedByEmployeeId, null);
  });

  it('records one pending refund when PayOS money arrives after cancellation', async () => {
    const { service, calls, tx, payment } = fixture({
      paymentStatus: 'FAILED',
      orderStatus: 'CANCELLED',
    });
    let storedRefund;
    tx.refund.findUnique = async () => storedRefund;
    const createRefund = tx.refund.create;
    tx.refund.create = async (args) => {
      storedRefund = await createRefund(args);
      return storedRefund;
    };

    const first = await service.recordLatePayosPayment(payment.id, 50_000, 'late-bank-ref');
    const second = await service.recordLatePayosPayment(payment.id, 50_000, 'late-bank-ref');

    assert.equal(first.id, second.id);
    assert.equal(calls.refundCreates.length, 1);
    assert.equal(calls.refundCreates[0].source, 'LATE_PAYMENT');
    assert.equal(calls.refundCreates[0].status, 'PENDING');
    assert.equal(calls.paymentUpdates[0].status, 'SUCCESS');
    assert.deepEqual(
      calls.events.map((event) => event.type),
      ['manager.order.attention-required', 'refund.pending'],
    );
  });

  it('records a pending refund when PayOS arrives after the cashier switched to cash', async () => {
    const { service, calls, tx, payment } = fixture({
      paymentStatus: 'FAILED',
      orderStatus: 'PREPARING',
      failureReason: 'PAYOS_CANCELLED_SWITCH_TO_CASH',
    });
    tx.payment.findFirst = async ({ where }) =>
      where.method === 'CASH' ? { id: 'cash-payment-id' } : { id: payment.id };

    const refund = await service.recordLatePayosPayment(payment.id, 50_000, 'late-after-cash');

    assert.equal(refund.status, 'PENDING');
    assert.equal(refund.reason, 'PayOS payment received after the order was paid in cash');
    assert.equal(calls.refundCreates[0].source, 'LATE_PAYMENT');
    assert.equal(calls.events[0].data.reason, 'PAYMENT_RECEIVED_AFTER_SWITCH_TO_CASH');
  });
});
