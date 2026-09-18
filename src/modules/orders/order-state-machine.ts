import { BadRequestException } from '@nestjs/common';
import { OrderItemStatus, OrderStatus } from '../../generated/prisma/client.js';

const itemTransitions = new Map<OrderItemStatus, ReadonlySet<OrderItemStatus>>([
  [OrderItemStatus.PENDING, new Set([OrderItemStatus.QUEUED, OrderItemStatus.CANCELLED])],
  [OrderItemStatus.QUEUED, new Set([OrderItemStatus.PREPARING, OrderItemStatus.OUT_OF_STOCK])],
  [OrderItemStatus.PREPARING, new Set([OrderItemStatus.READY, OrderItemStatus.OUT_OF_STOCK])],
  [OrderItemStatus.READY, new Set([OrderItemStatus.SERVED])],
]);

export function assertItemTransition(from: OrderItemStatus, to: OrderItemStatus): void {
  if (!itemTransitions.get(from)?.has(to)) {
    throw new BadRequestException(`Order item cannot transition from ${from} to ${to}`);
  }
}

export function deriveOrderStatus(statuses: OrderItemStatus[]): OrderStatus {
  if (statuses.length === 0 || statuses.every((status) => status === OrderItemStatus.PENDING))
    return OrderStatus.PENDING;
  const active = statuses.filter(
    (status) => status !== OrderItemStatus.CANCELLED && status !== OrderItemStatus.OUT_OF_STOCK,
  );
  if (active.length === 0) return OrderStatus.CANCELLED;
  if (active.every((status) => status === OrderItemStatus.SERVED)) return OrderStatus.SERVED;
  if (
    active.every((status) => status === OrderItemStatus.READY || status === OrderItemStatus.SERVED)
  )
    return OrderStatus.READY;
  if (active.some((status) => status === OrderItemStatus.PREPARING)) return OrderStatus.PREPARING;
  return OrderStatus.SUBMITTED;
}
