import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationPipe } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { ManagerOperationsService } from '../dist/modules/branch-manager/manager-operations.service.js';
import { PaidOrderRefundService } from '../dist/modules/payments/paid-order-refund.service.js';
import { BranchManagerController } from '../dist/modules/branch-manager/branch-manager.controller.js';
import {
  ManagerAttentionRefundDto,
  ManagerResolveAttentionDto,
  ManagerResumeItemsDto,
} from '../dist/modules/branch-manager/manager.dto.js';

const manager = { id: 'u-mgr', role: 'MANAGER', employeeId: 'emp-1', branchId: 'b1' };
const cashier = { id: 'u-cas', role: 'CASHIER', employeeId: 'emp-2', branchId: 'b1' };
const status = (code) => (error) => error?.getStatus?.() === code;
const ITEM = '11111111-1111-4111-8111-111111111111';
const COMBO = '22222222-2222-4222-8222-222222222222';
const COMBO_PART = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';

describe('BM-05 Store Manager cash refund for an order that needs attention', () => {
  function build(order) {
    const prisma = { order: { findFirst: async () => order } };
    const service = new PaidOrderRefundService(prisma, {}, {});
    const calls = [];
    service.cancelPaidOrder = async (user, orderId, dto) => (calls.push({ user, orderId, dto }), { ok: true });
    return { service, calls };
  }
  const latePaid = {
    status: 'CANCELLED',
    attentionReason: 'PAYMENT_RECEIVED_AFTER_CANCELLATION',
    items: [],
    payments: [{ status: 'REQUIRES_ATTENTION', failureReason: 'PAYMENT_RECEIVED_AFTER_CANCELLATION', refunds: [] }],
  };

  it('refunds QR money that arrived after cancellation, in cash, for the whole amount', async () => {
    const { service, calls } = build(latePaid);
    await service.managerAttentionRefund(manager, 'o1', { reasonCode: 'OTHER', note: 'Khách đã đi, trả lại tiền QR' });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].dto, {
      reason: 'OTHER: Khách đã đi, trả lại tiền QR',
      reasonCode: 'OTHER',
      refundMethod: 'CASH',
      orderItemIds: [],
    });
  });

  it('refuses orders that do not need attention, and late money already refunded', async () => {
    const paid = { status: 'COMPLETED', attentionReason: null, items: [], payments: [{ status: 'SUCCESS', failureReason: null, refunds: [] }] };
    await assert.rejects(build(paid).service.managerAttentionRefund(manager, 'o1', { reasonCode: 'CHANGE_OF_MIND' }), status(409));
    const refunded = { ...latePaid, payments: [{ ...latePaid.payments[0], refunds: [{ id: 'r1' }] }] };
    await assert.rejects(build(refunded).service.managerAttentionRefund(manager, 'o1', { reasonCode: 'OTHER', note: 'trả lại tiền' }), status(409));
  });

  it('only a Store Manager of the branch may use it', async () => {
    await assert.rejects(build(latePaid).service.managerAttentionRefund(cashier, 'o1', { reasonCode: 'OTHER', note: 'trả lại tiền' }), status(403));
    await assert.rejects(build(null).service.managerAttentionRefund(manager, 'o1', { reasonCode: 'OTHER', note: 'trả lại tiền' }), status(404));
  });

  it('refunds single lines only when they are out of stock (a combo by its root line)', async () => {
    const outOfStock = {
      status: 'REQUIRES_ATTENTION',
      attentionReason: 'PAID_ITEM_OUT_OF_STOCK',
      items: [
        { id: ITEM, status: 'OUT_OF_STOCK', parentId: null },
        { id: COMBO, status: 'QUEUED', parentId: null },
        { id: COMBO_PART, status: 'OUT_OF_STOCK', parentId: COMBO },
        { id: OTHER, status: 'QUEUED', parentId: null },
      ],
      payments: [{ status: 'SUCCESS', failureReason: null, refunds: [] }],
    };
    const { service, calls } = build(outOfStock);
    await service.managerAttentionRefund(manager, 'o1', { reasonCode: 'OUT_OF_STOCK', orderItemIds: [ITEM, COMBO] });
    assert.deepEqual(calls[0].dto.orderItemIds, [ITEM, COMBO]);
    assert.equal(calls[0].dto.reason, 'OUT_OF_STOCK');
    await assert.rejects(service.managerAttentionRefund(manager, 'o1', { reasonCode: 'OUT_OF_STOCK', orderItemIds: [OTHER] }), status(400));
    const mismatch = { ...outOfStock, attentionReason: 'PAYMENT_AMOUNT_MISMATCH' };
    await assert.rejects(build(mismatch).service.managerAttentionRefund(manager, 'o1', { reasonCode: 'OTHER', note: 'hoàn một món', orderItemIds: [ITEM] }), status(409));
  });
});

function operations({ order, soldOutItems = 0, soldOutOptions = 0 }) {
  const calls = { unitUpdates: [], itemUpdates: [], orderUpdates: [], audits: [], counts: [] };
  const tx = {
    $queryRaw: async () => [],
    order: {
      findFirst: async () => order,
      update: async ({ data }) => (calls.orderUpdates.push(data), { ...order, ...data }),
    },
    orderItemUnit: { updateMany: async (args) => (calls.unitUpdates.push(args), { count: 1 }) },
    orderItem: { updateMany: async (args) => (calls.itemUpdates.push(args), { count: 1 }) },
    branchMenuItem: { count: async (args) => (calls.counts.push(args), soldOutItems) },
    branchMenuOption: { count: async (args) => (calls.counts.push(args), soldOutOptions) },
    branchAuditLog: { create: async ({ data }) => (calls.audits.push(data), data) },
  };
  const prisma = { $transaction: async (work) => work(tx) };
  const access = { assertCanAccessBranch: async () => undefined, assertSubscriptionAllowsWrite: async () => undefined };
  return { service: new ManagerOperationsService(prisma, access), calls };
}

describe('BM-05 resume out-of-stock lines once the item is back', () => {
  const order = (items) => ({
    id: 'o1',
    status: 'REQUIRES_ATTENTION',
    callNumber: 12,
    attentionReason: 'PAID_OPTION_OUT_OF_STOCK',
    items,
  });

  it('puts every out-of-stock line back in the queue and closes the case', async () => {
    const { service, calls } = operations({
      order: order([
        { id: ITEM, status: 'OUT_OF_STOCK', parentId: null, menuItemId: 'm1', selectedOptions: [{ id: 'opt-1', name: 'Trân châu' }] },
        { id: OTHER, status: 'PREPARING', parentId: null, menuItemId: 'm2', selectedOptions: null },
      ]),
    });
    const result = await service.resumeOutOfStockItems(manager, 'o1', { note: 'Đã có hàng lại' });
    assert.deepEqual(result, { orderId: 'o1', callNumber: 12, status: 'PREPARING', resumedItemIds: [ITEM], resolved: true });
    assert.deepEqual(calls.unitUpdates[0].data, { status: 'QUEUED', startedAt: null, startedById: null });
    assert.deepEqual(calls.itemUpdates[0].where, { id: { in: [ITEM] } });
    assert.deepEqual(calls.orderUpdates[0], { status: 'PREPARING', attentionAt: null, attentionReason: null });
    assert.equal(calls.audits[0].action, 'OUT_OF_STOCK_ITEMS_RESUMED');
    assert.deepEqual(calls.counts.map((c) => c.where.menuItemId?.in ?? c.where.optionId?.in), [['m1'], ['opt-1']]);
  });

  it('keeps the order in "needs attention" while another line is still out of stock', async () => {
    const { service, calls } = operations({
      order: order([
        { id: ITEM, status: 'OUT_OF_STOCK', parentId: null, menuItemId: 'm1', selectedOptions: null },
        { id: OTHER, status: 'OUT_OF_STOCK', parentId: null, menuItemId: 'm2', selectedOptions: null },
      ]),
    });
    const result = await service.resumeOutOfStockItems(manager, 'o1', { orderItemIds: [ITEM] });
    assert.equal(result.resolved, false);
    assert.deepEqual(calls.orderUpdates[0], { status: 'REQUIRES_ATTENTION' });
  });

  it('refuses while the item or option is still sold out, or for lines that are not out of stock', async () => {
    const items = [{ id: ITEM, status: 'OUT_OF_STOCK', parentId: null, menuItemId: 'm1', selectedOptions: null }, { id: OTHER, status: 'QUEUED', parentId: null, menuItemId: 'm2', selectedOptions: null }];
    await assert.rejects(operations({ order: order(items), soldOutItems: 1 }).service.resumeOutOfStockItems(manager, 'o1', {}), status(409));
    await assert.rejects(operations({ order: order(items) }).service.resumeOutOfStockItems(manager, 'o1', { orderItemIds: [OTHER] }), status(400));
    await assert.rejects(
      operations({ order: { ...order(items), attentionReason: 'PAYMENT_AMOUNT_MISMATCH' } }).service.resumeOutOfStockItems(manager, 'o1', {}),
      status(409),
    );
  });
});

describe('BM-05 close an attention case with no dedicated action', () => {
  const base = { id: 'o1', status: 'REQUIRES_ATTENTION', paymentStatus: 'PAID', attentionReason: 'LEGACY_REASON', items: [{ status: 'READY' }], payments: [{ status: 'SUCCESS' }] };

  it('returns a paid order to its kitchen status and an unpaid one to "awaiting payment"', async () => {
    const paid = operations({ order: base });
    assert.deepEqual(await paid.service.resolveAttention(manager, 'o1', { note: 'Đã kiểm tra với thu ngân' }), { orderId: 'o1', status: 'READY' });
    assert.deepEqual(paid.calls.orderUpdates[0], { status: 'READY', attentionAt: null, attentionReason: null });
    assert.equal(paid.calls.audits[0].action, 'ORDER_ATTENTION_RESOLVED');
    assert.equal(paid.calls.audits[0].reason, 'Đã kiểm tra với thu ngân');
    const unpaid = operations({ order: { ...base, paymentStatus: 'UNPAID', attentionReason: null, payments: [] } });
    assert.equal((await unpaid.service.resolveAttention(manager, 'o1', { note: 'Đã kiểm tra' })).status, 'CONFIRMED');
  });

  it('refuses cases that have their own action, so money or kitchen state is never skipped', async () => {
    for (const order of [
      { ...base, attentionReason: 'PAYMENT_AMOUNT_MISMATCH' },
      { ...base, attentionReason: null, payments: [{ status: 'AMOUNT_MISMATCH' }] },
      { ...base, items: [{ status: 'OUT_OF_STOCK' }] },
      { ...base, status: 'COMPLETED' },
    ])
      await assert.rejects(operations({ order }).service.resolveAttention(manager, 'o1', { note: 'Đã kiểm tra' }), status(409));
  });
});

describe('BM-05 attention routes and payloads', () => {
  it('exposes the three Store Manager actions as POST routes', () => {
    const routes = ['attentionRefund', 'resumeItems', 'resolveAttention'].map((name) => {
      const handler = BranchManagerController.prototype[name];
      return [Reflect.getMetadata(METHOD_METADATA, handler), Reflect.getMetadata(PATH_METADATA, handler)];
    });
    assert.deepEqual(routes, [
      [1, 'orders/:orderId/attention/refund'],
      [1, 'orders/:orderId/attention/resume-items'],
      [1, 'orders/:orderId/attention/resolve'],
    ]);
  });

  it('validates the bodies', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const body = (metatype, value) => pipe.transform(value, { type: 'body', metatype });
    assert.deepEqual(await body(ManagerAttentionRefundDto, { reasonCode: 'OUT_OF_STOCK', orderItemIds: [ITEM] }), Object.assign(new ManagerAttentionRefundDto(), { reasonCode: 'OUT_OF_STOCK', orderItemIds: [ITEM] }));
    await assert.rejects(body(ManagerAttentionRefundDto, { reasonCode: 'NOPE' }));
    await assert.rejects(body(ManagerAttentionRefundDto, { reasonCode: 'OTHER', refundMethod: 'BANK_TRANSFER' }));
    await assert.rejects(body(ManagerResumeItemsDto, { orderItemIds: ['not-a-uuid'] }));
    await assert.rejects(body(ManagerResolveAttentionDto, { note: 'ok' }));
    assert.equal((await body(ManagerResolveAttentionDto, { note: '  Đã kiểm tra  ' })).note, 'Đã kiểm tra');
  });
});
