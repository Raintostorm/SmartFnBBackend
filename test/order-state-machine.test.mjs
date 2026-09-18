import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OrderItemStatus, OrderStatus } from '../dist/generated/prisma/client.js';
import { assertItemTransition, deriveOrderStatus } from '../dist/modules/orders/order-state-machine.js';

describe('order state machine', () => {
  it('accepts the complete kitchen-to-waiter happy path', () => {
    assert.doesNotThrow(() => assertItemTransition(OrderItemStatus.PENDING, OrderItemStatus.QUEUED));
    assert.doesNotThrow(() => assertItemTransition(OrderItemStatus.QUEUED, OrderItemStatus.PREPARING));
    assert.doesNotThrow(() => assertItemTransition(OrderItemStatus.PREPARING, OrderItemStatus.READY));
    assert.doesNotThrow(() => assertItemTransition(OrderItemStatus.READY, OrderItemStatus.SERVED));
  });
  it('rejects skipping preparation', () => assert.throws(() => assertItemTransition(OrderItemStatus.QUEUED, OrderItemStatus.READY), (error) => error?.getStatus?.() === 400));
  it('derives aggregate order state from all active items', () => {
    assert.equal(deriveOrderStatus([OrderItemStatus.QUEUED, OrderItemStatus.OUT_OF_STOCK]), OrderStatus.SUBMITTED);
    assert.equal(deriveOrderStatus([OrderItemStatus.READY, OrderItemStatus.SERVED]), OrderStatus.READY);
    assert.equal(deriveOrderStatus([OrderItemStatus.SERVED, OrderItemStatus.SERVED]), OrderStatus.SERVED);
  });
});
