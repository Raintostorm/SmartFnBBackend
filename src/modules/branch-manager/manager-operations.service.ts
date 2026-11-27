import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  OrderItemStatus,
  OrderPaymentStatus,
  OrderStatus,
  OrderType,
  PaymentStatus,
  Prisma,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import { AppRole } from '../auth/app-role.enum.js';
import type {
  ChainOrderQueryDto,
  ManagerAuditQueryDto,
  ManagerOrderQueryDto,
  ManagerResolveAttentionDto,
  ManagerResumeItemsDto,
} from './manager.dto.js';
import { managerActor, writeBranchAudit } from './manager-scope.js';

const actorSelect = { id: true, employeeCode: true, firstName: true, lastName: true };
const paymentSelect = {
  id: true,
  paymentCode: true,
  method: true,
  provider: true,
  status: true,
  amount: true,
  tenderedAmount: true,
  changeAmount: true,
  receivedAmount: true,
  expiresAt: true,
  stationId: true,
  transactionRef: true,
  confirmationReason: true,
  confirmedAt: true,
  paidAt: true,
  createdAt: true,
  failureReason: true,
  processedBy: { select: actorSelect },
  station: { select: { id: true, name: true, status: true } },
} satisfies Prisma.PaymentSelect;
const refundSelect = {
  id: true,
  paymentId: true,
  amount: true,
  status: true,
  method: true,
  source: true,
  sourceReference: true,
  reason: true,
  requestedByUserId: true,
  requestedByEmployeeId: true,
  requestedByRole: true,
  requestedAt: true,
  completedByUserId: true,
  completedByEmployeeId: true,
  completedByRole: true,
  completedAt: true,
  cancellationDate: true,
  note: true,
  items: {
    select: {
      orderItemId: true,
      quantity: true,
      refundAmount: true,
      isWastage: true,
    },
  },
} satisfies Prisma.RefundSelect;
const summarySelect = {
  id: true,
  orderCode: true,
  callNumber: true,
  type: true,
  status: true,
  paymentStatus: true,
  totalAmount: true,
  placedAt: true,
  paidAt: true,
  cancelledAt: true,
  cancellationReason: true,
  attentionAt: true,
  attentionReason: true,
  createdByCashier: { select: actorSelect },
  createdByWaiter: { select: actorSelect },
  payments: { select: paymentSelect },
  refunds: { select: refundSelect, orderBy: { requestedAt: 'asc' } },
  tableSession: { select: { id: true, sessionCode: true, payments: { select: paymentSelect } } },
} satisfies Prisma.OrderSelect;

/** Money that arrived after the order was cancelled or paid in cash: the manager must refund it (BR-50). */
export const LATE_PAYMENT_REASONS = ['PAYMENT_RECEIVED_AFTER_CANCELLATION', 'PAYMENT_RECEIVED_AFTER_SWITCH_TO_CASH'] as const;
/** Attention reasons that have their own action (confirm payment, refund, resume lines); "resolve" is for the rest. */
const HANDLED_ATTENTION_REASONS: string[] = [
  'PAYMENT_AMOUNT_MISMATCH',
  'PAYMENT_RECEIVED_AFTER_EXPIRY',
  'PAID_ITEM_OUT_OF_STOCK',
  'PAID_OPTION_OUT_OF_STOCK',
  ...LATE_PAYMENT_REASONS,
];
const OUT_OF_STOCK_REASONS = ['PAID_ITEM_OUT_OF_STOCK', 'PAID_OPTION_OUT_OF_STOCK'];

/** Kitchen status of a paid order from its live lines (same rule as after a partial refund). */
function preparationStatus(items: Array<{ status: OrderItemStatus }>): OrderStatus {
  if (items.some((item) => item.status === OrderItemStatus.OUT_OF_STOCK)) return OrderStatus.REQUIRES_ATTENTION;
  if (items.length && items.every((item) => item.status === OrderItemStatus.READY)) return OrderStatus.READY;
  if (items.some((item) => item.status === OrderItemStatus.PREPARING || item.status === OrderItemStatus.READY))
    return OrderStatus.PREPARING;
  return OrderStatus.SUBMITTED;
}

function optionIdsOf(selectedOptions: Prisma.JsonValue): string[] {
  if (!Array.isArray(selectedOptions)) return [];
  return selectedOptions.flatMap((option) =>
    option && typeof option === 'object' && !Array.isArray(option) && typeof option.id === 'string' ? [option.id] : [],
  );
}

@Injectable()
export class ManagerOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BranchAccessService,
  ) {}

  private async scope(user: AuthenticatedUser, write = false) {
    const actor = managerActor(user);
    await this.access.assertCanAccessBranch(user, actor.branchId);
    if (write) await this.access.assertSubscriptionAllowsWrite(actor.branchId);
    return actor;
  }

  async orders(user: AuthenticatedUser, query: ManagerOrderQueryDto) {
    const { branchId } = await this.scope(user);
    return this.searchOrders({ branchId }, query, false);
  }

  /** The chain must be assigned to the Brand Manager; anything else looks like it does not exist. */
  private async assertChainOwner(user: AuthenticatedUser, chainId: string) {
    if (user.role !== AppRole.OWNER || !user.ownerId)
      throw new ForbiddenException('Brand Manager required');
    const assigned = await this.prisma.ownerChainAssignment.count({
      where: { ownerId: user.ownerId, chainId, chain: { deletedAt: null } },
    });
    if (!assigned) throw new NotFoundException('Chain not found');
  }

  /** GAP-310: Brand Manager searches orders of one assigned chain, optionally narrowed to one branch. */
  async chainOrders(user: AuthenticatedUser, chainId: string, query: ChainOrderQueryDto) {
    await this.assertChainOwner(user, chainId);
    if (query.branchId) {
      const inChain = await this.prisma.branch.count({
        where: { id: query.branchId, chainId, deletedAt: null },
      });
      if (!inChain) throw new NotFoundException('Branch not found in this chain');
    }
    return this.searchOrders(
      {
        branch: { chainId, deletedAt: null },
        ...(query.branchId ? { branchId: query.branchId } : {}),
      },
      query,
      true,
    );
  }

  /** GAP-310: one order of an assigned chain, same shape as the Store Manager order detail plus its branch. */
  async chainOrder(user: AuthenticatedUser, chainId: string, id: string) {
    await this.assertChainOwner(user, chainId);
    return this.loadOrder(
      { id, branch: { chainId, deletedAt: null } },
      true,
      'Order not found in this chain',
    );
  }

  private async searchOrders(
    scopeWhere: Prisma.OrderWhereInput,
    query: ManagerOrderQueryDto,
    withBranch: boolean,
  ) {
    if (query.from && query.to && new Date(query.from) >= new Date(query.to))
      throw new BadRequestException('from must be earlier than to');
    const search = query.search?.trim();
    const number = search && /^\d+$/.test(search) ? Number(search) : undefined;
    const where: Prisma.OrderWhereInput = {
      ...scopeWhere,
      type: query.type,
      status: query.status,
      paymentStatus: query.paymentStatus,
      callNumber: query.callNumber,
      ...(query.orderCode
        ? { orderCode: { contains: query.orderCode.trim(), mode: 'insensitive' } }
        : {}),
      ...(query.from || query.to
        ? {
            placedAt: {
              gte: query.from ? new Date(query.from) : undefined,
              lt: query.to ? new Date(query.to) : undefined,
            },
          }
        : {}),
      ...(query.refundStatus ? { refunds: { some: { status: query.refundStatus } } } : {}),
      AND: [
        // BM-05: a late payment leaves the order CANCELLED (or paid in cash) and only the payment in
        // REQUIRES_ATTENTION; it still needs the manager until a refund is recorded for that payment.
        // Default list: no drafts or "Chờ thanh toán" orders (unpaid, still awaiting payment); attention cases stay.
        ...(query.hideAwaitingPayment && !query.status
          ? [{ NOT: { paymentStatus: OrderPaymentStatus.UNPAID, status: { in: [OrderStatus.PENDING, OrderStatus.CONFIRMED] } } }]
          : []),
        ...(query.needsAttention
          ? [
              {
                OR: [
                  { status: OrderStatus.REQUIRES_ATTENTION },
                  {
                    payments: {
                      some: {
                        status: PaymentStatus.REQUIRES_ATTENTION,
                        failureReason: { in: [...LATE_PAYMENT_REASONS] },
                        refunds: { none: {} },
                      },
                    },
                  },
                ],
              },
            ]
          : []),
        ...(search
          ? [
              {
                OR: [
                  { orderCode: { contains: search, mode: Prisma.QueryMode.insensitive } },
                  ...(number && number <= 2147483647 ? [{ callNumber: number }] : []),
                ],
              },
            ]
          : []),
        ...(query.paymentMethod
          ? [
              {
                OR: [
                  { payments: { some: { method: query.paymentMethod } } },
                  { tableSession: { payments: { some: { method: query.paymentMethod } } } },
                ],
              },
            ]
          : []),
        ...(query.paymentRecordStatus
          ? [
              {
                OR: [
                  { payments: { some: { status: query.paymentRecordStatus } } },
                  {
                    tableSession: {
                      payments: { some: { status: query.paymentRecordStatus } },
                    },
                  },
                ],
              },
            ]
          : []),
      ],
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        select: {
          ...summarySelect,
          ...(withBranch ? { branch: { select: { id: true, code: true, name: true } } } : {}),
        },
        orderBy: [
          { [query.sortBy ?? 'placedAt']: query.sortOrder ?? 'desc' },
          { id: query.sortOrder ?? 'desc' },
        ],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.order.count({ where }),
    ]);
    return { items, total, page: query.page, limit: query.limit };
  }

  async order(user: AuthenticatedUser, id: string) {
    const { branchId } = await this.scope(user);
    return this.loadOrder({ id, branchId }, false, 'Order not found in your branch');
  }

  private async loadOrder(where: Prisma.OrderWhereInput, withBranch: boolean, notFound: string) {
    const order = await this.prisma.order.findFirst({
      where,
      select: {
        ...summarySelect,
        ...(withBranch ? { branch: { select: { id: true, code: true, name: true } } } : {}),
        branchId: true,
        subtotal: true,
        discountAmount: true,
        taxAmount: true,
        serviceCharge: true,
        note: true,
        submittedAt: true,
        readyAt: true,
        deliveredAt: true,
        completedAt: true,
        cancelledBy: { select: actorSelect },
        items: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            menuItemId: true,
            itemName: true,
            unitPrice: true,
            quantity: true,
            discountAmount: true,
            totalPrice: true,
            selectedOptions: true,
            status: true,
            specialInstructions: true,
            parentId: true,
            cancellationReason: true,
            cancelledAt: true,
            cancelledBy: { select: actorSelect },
            startedAt: true,
            completedAt: true,
          },
        },
      },
    });
    if (!order) throw new NotFoundException(notFound);
    const paymentIds = [...order.payments, ...(order.tableSession?.payments ?? [])].map(
      (p) => p.id,
    );
    const refundIds = order.refunds.map((refund) => refund.id);
    const actorUserIds = [
      ...new Set(
        order.refunds.flatMap((refund) =>
          [refund.requestedByUserId, refund.completedByUserId].filter(
            (userId): userId is string => userId !== null,
          ),
        ),
      ),
    ];
    const [audit, actorUsers] = await Promise.all([
      this.prisma.branchAuditLog.findMany({
        where: { branchId: order.branchId, entityId: { in: [order.id, ...paymentIds, ...refundIds] } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      actorUserIds.length
        ? this.prisma.user.findMany({
            where: { id: { in: actorUserIds } },
            select: {
              id: true,
              email: true,
              employee: { select: actorSelect },
              owner: { select: { id: true, ownerCode: true, firstName: true, lastName: true } },
            },
          })
        : [],
    ]);
    const actors = new Map(
      actorUsers.map((actor) => [
        actor.id,
        {
          id: actor.id,
          email: actor.email,
          profile: actor.employee ?? actor.owner,
        },
      ]),
    );
    return {
      ...order,
      refunds: order.refunds.map((refund) => ({
        ...refund,
        requestedBy: refund.requestedByUserId
          ? (actors.get(refund.requestedByUserId) ?? null)
          : null,
        completedBy: refund.completedByUserId
          ? (actors.get(refund.completedByUserId) ?? null)
          : null,
      })),
      audit,
    };
  }

  async audit(user: AuthenticatedUser, query: ManagerAuditQueryDto) {
    const { branchId } = await this.scope(user);
    const where = { branchId, entityId: query.entityId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.branchAuditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.branchAuditLog.count({ where }),
    ]);
    return { items, total, page: query.page, limit: query.limit };
  }

  async options(user: AuthenticatedUser) {
    const { branchId } = await this.scope(user);
    const options = await this.prisma.menuOption.findMany({
      where: { group: { chain: { branches: { some: { id: branchId } } } } },
      select: {
        id: true,
        name: true,
        priceDelta: true,
        isActive: true,
        group: { select: { id: true, name: true, isActive: true } },
        branchAvailability: { where: { branchId }, select: { isAvailable: true } },
      },
      orderBy: { name: 'asc' },
    });
    return options.map(({ branchAvailability, ...option }) => ({
      ...option,
      isAvailable: branchAvailability[0]?.isAvailable ?? true,
      effectiveAvailable:
        option.isActive && option.group.isActive && (branchAvailability[0]?.isAvailable ?? true),
    }));
  }

  async optionAvailability(user: AuthenticatedUser, id: string, isAvailable: boolean) {
    const { branchId, employeeId } = await this.scope(user, true);
    return this.prisma.$transaction(
      async (tx) => {
        const option = await tx.menuOption.findFirst({
          where: { id, group: { chain: { branches: { some: { id: branchId } } } } },
          select: { id: true, isActive: true, group: { select: { isActive: true } } },
        });
        if (!option) throw new NotFoundException('Option not found in your chain');
        const before = await tx.branchMenuOption.findUnique({
          where: { branchId_optionId: { branchId, optionId: id } },
        });
        await tx.branchMenuOption.upsert({
          where: { branchId_optionId: { branchId, optionId: id } },
          create: { branchId, optionId: id, isAvailable, updatedById: employeeId },
          update: { isAvailable, updatedById: employeeId },
        });
        const items = isAvailable
          ? []
          : await tx.orderItem.findMany({
              where: {
                selectedOptions: { array_contains: [{ id }] },
                status: { in: ['QUEUED', 'PREPARING'] },
                order: { branchId, type: 'COUNTER_PICKUP', paymentStatus: 'PAID' },
              },
              select: { id: true, orderId: true },
            });
        if (items.length) {
          const now = new Date();
          const orderIds = [...new Set(items.map((item) => item.orderId))];
          await tx.orderItemUnit.updateMany({
            where: {
              orderItemId: { in: items.map((i) => i.id) },
              status: { in: ['QUEUED', 'PREPARING'] },
            },
            data: { status: 'OUT_OF_STOCK' },
          });
          await tx.orderItem.updateMany({
            where: { id: { in: items.map((i) => i.id) } },
            data: {
              status: 'OUT_OF_STOCK',
              unavailableAt: now,
              unavailableById: employeeId,
            },
          });
          await tx.order.updateMany({
            where: { id: { in: orderIds } },
            data: {
              status: 'REQUIRES_ATTENTION',
              attentionAt: now,
              attentionReason: 'PAID_OPTION_OUT_OF_STOCK',
            },
          });
        }
        await writeBranchAudit(tx, user, {
          action: 'OPTION_AVAILABILITY_CHANGED',
          entityType: 'MENU_OPTION',
          entityId: id,
          before: { isAvailable: before?.isAvailable ?? true },
          after: { isAvailable },
        });
        return {
          optionId: id,
          isAvailable,
          effectiveAvailable: isAvailable && option.isActive && option.group.isActive,
          affectedOrderIds: [...new Set(items.map((i) => i.orderId))],
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /**
   * BM-05 "Đơn cần xử lý" — hết món: the item (or option) is available again, so the out-of-stock lines of the
   * paid order go back to the preparation queue. The menu must be re-opened first, otherwise the barista would
   * mark them sold out again. When no out-of-stock line remains the order leaves "Cần xử lý".
   */
  async resumeOutOfStockItems(user: AuthenticatedUser, orderId: string, dto: ManagerResumeItemsDto) {
    const { branchId } = await this.scope(user, true);
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
        const order = await tx.order.findFirst({
          where: { id: orderId, branchId, type: OrderType.COUNTER_PICKUP },
          select: {
            id: true,
            status: true,
            callNumber: true,
            attentionReason: true,
            items: { select: { id: true, status: true, parentId: true, menuItemId: true, selectedOptions: true } },
          },
        });
        if (!order) throw new NotFoundException('Counter order was not found in your branch');
        if (order.status !== OrderStatus.REQUIRES_ATTENTION || !OUT_OF_STOCK_REASONS.includes(order.attentionReason ?? ''))
          throw new ConflictException('This order has no out-of-stock line to resume');
        const outOfStock = order.items.filter((item) => item.status === OrderItemStatus.OUT_OF_STOCK);
        const wanted = new Set(dto.orderItemIds ?? []);
        // A combo is chosen by its root line; its out-of-stock components follow it.
        const selected = wanted.size
          ? outOfStock.filter((item) => wanted.has(item.id) || (!!item.parentId && wanted.has(item.parentId)))
          : outOfStock;
        const known = new Set(outOfStock.flatMap((item) => [item.id, item.parentId ?? item.id]));
        if (!selected.length || [...wanted].some((id) => !known.has(id)))
          throw new BadRequestException('Only out-of-stock lines of this order can be resumed');

        const menuItemIds = [...new Set(selected.flatMap((item) => (item.menuItemId ? [item.menuItemId] : [])))];
        const optionIds = [...new Set(selected.flatMap((item) => optionIdsOf(item.selectedOptions)))];
        const [soldOutItems, soldOutOptions] = await Promise.all([
          menuItemIds.length
            ? tx.branchMenuItem.count({ where: { branchId, menuItemId: { in: menuItemIds }, isAvailable: false } })
            : 0,
          optionIds.length
            ? tx.branchMenuOption.count({ where: { branchId, optionId: { in: optionIds }, isAvailable: false } })
            : 0,
        ]);
        if (soldOutItems || soldOutOptions)
          throw new ConflictException('Mark the item or option available again before resuming these lines');

        const ids = selected.map((item) => item.id);
        await tx.orderItemUnit.updateMany({
          where: { orderItemId: { in: ids }, status: OrderItemStatus.OUT_OF_STOCK },
          data: { status: OrderItemStatus.QUEUED, startedAt: null, startedById: null },
        });
        await tx.orderItem.updateMany({
          where: { id: { in: ids } },
          data: { status: OrderItemStatus.QUEUED, startedAt: null },
        });
        const live = order.items
          .filter((item) => item.status !== OrderItemStatus.CANCELLED)
          .map((item) => (ids.includes(item.id) ? { ...item, status: OrderItemStatus.QUEUED } : item));
        const status = preparationStatus(live);
        const resolved = status !== OrderStatus.REQUIRES_ATTENTION;
        await tx.order.update({
          where: { id: order.id },
          data: { status, ...(resolved ? { attentionAt: null, attentionReason: null } : {}) },
        });
        await writeBranchAudit(tx, user, {
          action: 'OUT_OF_STOCK_ITEMS_RESUMED',
          entityType: 'ORDER',
          entityId: order.id,
          reason: dto.note?.trim() || undefined,
          before: { status: order.status, attentionReason: order.attentionReason },
          after: { status, resumedItemIds: ids },
        });
        return { orderId: order.id, callNumber: order.callNumber, status, resumedItemIds: ids, resolved };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /**
   * BM-05: close an attention case whose reason has no dedicated action (unknown or legacy reason), after the
   * manager checked it. Cases with a dedicated action (confirm payment, refund, resume lines) are refused so the
   * money or the kitchen state is never skipped.
   */
  async resolveAttention(user: AuthenticatedUser, orderId: string, dto: ManagerResolveAttentionDto) {
    const { branchId } = await this.scope(user, true);
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
        const order = await tx.order.findFirst({
          where: { id: orderId, branchId, type: OrderType.COUNTER_PICKUP },
          select: {
            id: true,
            status: true,
            paymentStatus: true,
            attentionReason: true,
            items: { select: { status: true } },
            payments: { select: { status: true } },
          },
        });
        if (!order) throw new NotFoundException('Counter order was not found in your branch');
        if (order.status !== OrderStatus.REQUIRES_ATTENTION) throw new ConflictException('Order no longer needs attention');
        if (
          HANDLED_ATTENTION_REASONS.includes(order.attentionReason ?? '') ||
          order.payments.some(
            (p) => p.status === PaymentStatus.AMOUNT_MISMATCH || p.status === PaymentStatus.REQUIRES_ATTENTION,
          ) ||
          order.items.some((item) => item.status === OrderItemStatus.OUT_OF_STOCK)
        )
          throw new ConflictException('Use the dedicated action for this case: confirm the payment, refund, or resume the lines');
        const live = order.items.filter((item) => item.status !== OrderItemStatus.CANCELLED);
        const status =
          order.paymentStatus === OrderPaymentStatus.PAID ? preparationStatus(live) : OrderStatus.CONFIRMED;
        await tx.order.update({
          where: { id: order.id },
          data: { status, attentionAt: null, attentionReason: null },
        });
        await writeBranchAudit(tx, user, {
          action: 'ORDER_ATTENTION_RESOLVED',
          entityType: 'ORDER',
          entityId: order.id,
          reason: dto.note.trim(),
          before: { status: order.status, attentionReason: order.attentionReason },
          after: { status },
        });
        return { orderId: order.id, status };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}
