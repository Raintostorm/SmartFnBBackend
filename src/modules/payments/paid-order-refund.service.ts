import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  OrderItemStatus,
  OrderPaymentStatus,
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentStatus,
  PrintJobStatus,
  Prisma,
  RefundMethod,
  RefundApprovalStatus,
  RefundSource,
  RefundStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { RealtimePublisher } from '../../realtime/realtime.publisher.js';
import { AppRole } from '../auth/app-role.enum.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { writeBranchAudit } from '../branch-manager/manager-scope.js';
import type { CancelPaidOrderDto, CompleteRefundDto } from '../branch-manager/manager.dto.js';
import type { RefundListQueryDto } from './dto/payment.dto.js';
import type { CashierRefundDto } from './cashier-refunds.controller.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import { RefundDocumentsService } from '../receipt-documents/refund-documents.service.js';

const cancellableOrderStatuses = [
  OrderStatus.SUBMITTED,
  OrderStatus.PREPARING,
  OrderStatus.READY,
  OrderStatus.REQUIRES_ATTENTION,
  OrderStatus.COMPLETED,
  OrderStatus.DELIVERED,
];

const refundInclude = {
  items: {
    orderBy: { id: 'asc' as const },
    include: {
      orderItem: { select: { id: true, itemName: true, quantity: true, status: true } },
    },
  },
} satisfies Prisma.RefundInclude;

@Injectable()
export class PaidOrderRefundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimePublisher,
    private readonly branchAccess: BranchAccessService,
    @Optional() private readonly refundDocuments?: RefundDocumentsService,
  ) {}

  async listRefunds(user: AuthenticatedUser, query: RefundListQueryDto) {
    if (![AppRole.OWNER, AppRole.MANAGER].includes(user.role)) {
      throw new ForbiddenException('Only an Owner or Store Manager can list refunds');
    }
    const accessible = await this.branchAccess.getAccessibleBranchIds(user);
    const allowed = new Set(accessible ?? []);
    const selected = query.branchIds?.length ? query.branchIds : [...allowed];
    if (selected.some((id) => !allowed.has(id))) {
      throw new ForbiddenException('A requested branch is outside your scope');
    }
    const requestedAt = {
      ...(query.from ? { gte: new Date(query.from) } : {}),
      ...(query.to ? { lte: new Date(query.to) } : {}),
    };
    const where: Prisma.RefundWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.method ? { method: query.method } : {}),
      ...(query.from || query.to ? { requestedAt } : {}),
      order: {
        branchId: { in: selected },
        ...(query.chainId ? { branch: { chainId: query.chainId } } : {}),
      },
    };
    const include = {
      order: {
        select: {
          id: true,
          orderCode: true,
          callNumber: true,
          branch: { select: { id: true, code: true, name: true, chainId: true } },
        },
      },
      payment: {
        select: { id: true, method: true, transactionRef: true, providerTransactionId: true },
      },
      ...refundInclude,
    } satisfies Prisma.RefundInclude;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.refund.findMany({
        where,
        include,
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.refund.count({ where }),
    ]);
    return { items, total, page: query.page, limit: query.limit };
  }

  async recordLatePayosPayment(
    paymentId: string,
    receivedAmount: string | number | Prisma.Decimal,
    providerTransactionId?: string,
  ) {
    const received = new Prisma.Decimal(receivedAmount);
    if (received.lte(0)) throw new ConflictException('Received amount must be positive');
    const sourceReference = `late-payment:${paymentId}`;
    const result = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
        const existing = await tx.refund.findUnique({ where: { sourceReference } });
        if (existing) return { changed: false, branchId: null, refund: existing };
        const payment = await tx.payment.findUnique({
          where: { id: paymentId },
          include: {
            order: { include: { branch: { select: { timezone: true } } } },
          },
        });
        if (!payment?.order) {
          throw new ConflictException('Late payment is not linked to an order');
        }
        if (payment.status === PaymentStatus.SUCCESS)
          return { changed: false, branchId: payment.order.branchId, payment, reason: null };
        if (
          payment.status === PaymentStatus.REQUIRES_ATTENTION &&
          ['PAYMENT_RECEIVED_AFTER_CANCELLATION', 'PAYMENT_RECEIVED_AFTER_SWITCH_TO_CASH'].includes(
            payment.failureReason ?? '',
          )
        )
          return {
            changed: false,
            branchId: payment.order.branchId,
            payment,
            reason: payment.failureReason,
          };
        const switchedToCash = payment.failureReason === 'PAYOS_CANCELLED_SWITCH_TO_CASH';
        const replacementCashPayment = switchedToCash
          ? await tx.payment.findFirst({
              where: {
                orderId: payment.order.id,
                id: { not: payment.id },
                method: PaymentMethod.CASH,
                status: PaymentStatus.SUCCESS,
              },
              select: { id: true },
            })
          : null;
        if (
          payment.order.status !== OrderStatus.CANCELLED &&
          !(switchedToCash && replacementCashPayment)
        ) {
          throw new ConflictException(
            'Late payment is not linked to a cancelled order or a completed cash switch',
          );
        }
        await tx.$queryRaw`SELECT id FROM orders WHERE id = ${payment.order.id}::uuid FOR UPDATE`;
        const now = new Date();
        const reason = replacementCashPayment
          ? 'PAYMENT_RECEIVED_AFTER_SWITCH_TO_CASH'
          : 'PAYMENT_RECEIVED_AFTER_CANCELLATION';
        const updated = await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.REQUIRES_ATTENTION,
            receivedAmount: received,
            paidAt: now,
            providerTransactionId: providerTransactionId ?? payment.providerTransactionId,
            failureReason: reason,
          },
        });
        await tx.order.update({
          where: { id: payment.order.id },
          data: {
            attentionAt: now,
            attentionReason: reason,
          },
        });
        return { changed: true, branchId: payment.order.branchId, payment: updated, reason };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    if (result.changed && result.branchId) {
      this.realtime.branch(result.branchId, 'manager.order.attention-required', {
        reason: 'reason' in result ? result.reason : 'PAYMENT_RECEIVED_AFTER_CANCELLATION',
        orderId: result.payment?.orderId,
        paymentId,
        receivedAmount: received.toString(),
      });
    }
    return 'payment' in result ? result.payment : result.refund;
  }

  async cashierRefund(user: AuthenticatedUser, orderId: string, dto: CashierRefundDto) {
    if (user.role !== AppRole.CASHIER) throw new ForbiddenException('Cashier required');
    const codes = ['CHANGE_OF_MIND', 'WRONG_ITEM', 'OUT_OF_STOCK', 'LONG_WAIT', 'OTHER'];
    if (
      !codes.includes(dto.reasonCode) ||
      (dto.reasonCode === 'OTHER' && (dto.note?.trim().length ?? 0) < 5)
    )
      throw new BadRequestException(
        'Valid reason required; OTHER requires a note of at least 5 characters',
      );
    return this.cancelPaidOrder(user, orderId, {
      reason: dto.reasonCode + (dto.note?.trim() ? ': ' + dto.note.trim() : ''),
      refundMethod: RefundMethod.CASH,
      reasonCode: dto.reasonCode,
      orderItemIds: dto.items?.map((item) => item.orderItemId),
    });
  }

  async requestRefundApproval(user: AuthenticatedUser, orderId: string, dto: CashierRefundDto) {
    if (user.role !== AppRole.CASHIER || !user.branchId || !user.employeeId)
      throw new ForbiddenException('Assigned Cashier required');
    const reason = dto.reasonCode + (dto.note?.trim() ? ': ' + dto.note.trim() : '');
    if (
      !['CHANGE_OF_MIND', 'WRONG_ITEM', 'OUT_OF_STOCK', 'LONG_WAIT', 'OTHER'].includes(dto.reasonCode) ||
      (dto.reasonCode === 'OTHER' && (dto.note?.trim().length ?? 0) < 5)
    ) throw new BadRequestException('Valid refund reason required');
    const requestedIds = [...new Set(dto.items?.map((item) => item.orderItemId) ?? [])];
    const request = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findFirst({
        where: { id: orderId, branchId: user.branchId!, type: OrderType.COUNTER_PICKUP },
        include: {
          branch: { select: { timezone: true } },
          items: { include: { refundItems: { select: { id: true } } } },
          payments: { where: { status: { in: [PaymentStatus.SUCCESS, PaymentStatus.AMOUNT_MISMATCH, PaymentStatus.REQUIRES_ATTENTION] } }, orderBy: [{ status: 'desc' }, { createdAt: 'desc' }] },
          refunds: { select: { amount: true, paymentId: true } },
        },
      });
      if (!order) throw new NotFoundException('Counter order not found in your branch');
      const payment = order.payments[0];
      if (!payment) throw new ConflictException('Order has no received payment');
      const paidAt = payment.paidAt ?? order.paidAt;
      if (!paidAt) throw new ConflictException('Payment has no received date');
      if (this.businessDate(order.branch.timezone, paidAt).getTime() === this.businessDate(order.branch.timezone, new Date()).getTime())
        throw new ConflictException('Today’s paid order can be refunded directly by Cashier');
      const existing = await tx.refundApprovalRequest.findFirst({
        where: { orderId, status: { in: [RefundApprovalStatus.PENDING, RefundApprovalStatus.APPROVED] } },
        select: { id: true },
      });
      if (existing) throw new ConflictException('An open refund request already exists for this order');
      const lateReturn = payment.status === PaymentStatus.REQUIRES_ATTENTION && order.status === OrderStatus.CANCELLED &&
        ['PAYMENT_RECEIVED_AFTER_CANCELLATION', 'PAYMENT_RECEIVED_AFTER_SWITCH_TO_CASH'].includes(payment.failureReason ?? '');
      if (payment.status !== PaymentStatus.SUCCESS && requestedIds.length)
        throw new ConflictException('An underpaid or late payment must be refunded in full');
      const activeRoots = order.items.filter((item) => !item.parentId && item.status !== OrderItemStatus.CANCELLED && item.refundItems.length === 0);
      const selected = requestedIds.length ? activeRoots.filter((item) => requestedIds.includes(item.id)) : activeRoots;
      if ((!lateReturn && !selected.length) || (requestedIds.length && selected.length !== requestedIds.length))
        throw new ConflictException('One or more order lines are unavailable for refund');
      const received = payment.receivedAmount ?? payment.amount;
      const refunded = order.refunds.filter((item) => item.paymentId === payment.id).reduce((sum, item) => sum.add(item.amount), new Prisma.Decimal(0));
      const balance = received.sub(refunded);
      const selectedTotal = selected.reduce((sum, item) => sum.add(item.totalPrice), new Prisma.Decimal(0));
      const amount = requestedIds.length ? Prisma.Decimal.min(selectedTotal, balance) : balance;
      if (amount.lte(0)) throw new ConflictException('No refundable balance remains');
      const created = await tx.refundApprovalRequest.create({
        data: {
          orderId,
          branchId: user.branchId!,
          orderItemIds: requestedIds,
          amount,
          reason,
          reasonCode: dto.reasonCode,
          requestedByUserId: user.id,
          requestedByEmployeeId: user.employeeId!,
        },
      });
      await writeBranchAudit(tx, user, {
        action: 'REFUND_APPROVAL_REQUESTED', entityType: 'REFUND_APPROVAL_REQUEST', entityId: created.id,
        reason, after: { orderId, amount: amount.toString(), orderItemIds: requestedIds },
      });
      return created;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    this.realtime.branch(user.branchId, 'refund.approval-requested', { requestId: request.id, orderId });
    return request;
  }

  async listRefundApprovalRequests(user: AuthenticatedUser) {
    if (![AppRole.CASHIER, AppRole.MANAGER].includes(user.role) || !user.branchId || !user.employeeId)
      throw new ForbiddenException('Assigned branch staff required');
    return this.prisma.refundApprovalRequest.findMany({
      where: { branchId: user.branchId },
      include: { order: { select: { id: true, orderCode: true, callNumber: true, paidAt: true } } },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
  }

  async reviewRefundApproval(user: AuthenticatedUser, requestId: string, approved: boolean, note?: string) {
    if (user.role !== AppRole.MANAGER || !user.branchId || !user.employeeId)
      throw new ForbiddenException('Assigned Store Manager required');
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM refund_approval_requests WHERE id = ${requestId}::uuid FOR UPDATE`;
      const request = await tx.refundApprovalRequest.findFirst({ where: { id: requestId, branchId: user.branchId! } });
      if (!request) throw new NotFoundException('Refund request not found in your branch');
      if (request.status !== RefundApprovalStatus.PENDING && !(request.status === RefundApprovalStatus.APPROVED && !approved))
        throw new ConflictException('Refund request can no longer be reviewed');
      const nextStatus = approved ? RefundApprovalStatus.APPROVED : RefundApprovalStatus.REJECTED;
      const next = await tx.refundApprovalRequest.update({
        where: { id: requestId },
        data: { status: nextStatus, reviewedByUserId: user.id, reviewedByEmployeeId: user.employeeId!, reviewedAt: new Date(), reviewNote: note?.trim() || null },
      });
      await writeBranchAudit(tx, user, {
        action: approved ? 'REFUND_APPROVAL_APPROVED' : 'REFUND_APPROVAL_REJECTED',
        entityType: 'REFUND_APPROVAL_REQUEST', entityId: requestId,
        reason: note, before: { status: request.status }, after: { status: nextStatus },
      });
      return next;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    this.realtime.branch(user.branchId, 'refund.approval-reviewed', { requestId, orderId: updated.orderId, status: updated.status });
    return updated;
  }

  async completeApprovedRefund(user: AuthenticatedUser, requestId: string) {
    if (user.role !== AppRole.CASHIER || !user.branchId || !user.employeeId)
      throw new ForbiddenException('Assigned Cashier required');
    const request = await this.prisma.refundApprovalRequest.findFirst({ where: { id: requestId, branchId: user.branchId } });
    if (!request) throw new NotFoundException('Refund request not found in your branch');
    if (request.status !== RefundApprovalStatus.APPROVED) throw new ConflictException('Refund request is not approved');
    const ids = Array.isArray(request.orderItemIds) ? request.orderItemIds.filter((id): id is string => typeof id === 'string') : [];
    return this.cancelPaidOrder(user, request.orderId, {
      refundMethod: RefundMethod.CASH, reasonCode: request.reasonCode, reason: request.reason, orderItemIds: ids,
    }, requestId);
  }

  async refundReceipt(user: AuthenticatedUser, orderId: string, refundId: string) {
    if (!['CASHIER', 'MANAGER'].includes(user.role) || !user.branchId || !user.employeeId)
      throw new ForbiddenException('Assigned branch staff required');
    const refund = await this.prisma.refund.findFirst({
      where: { id: refundId, orderId, order: { branchId: user.branchId, type: 'COUNTER_PICKUP' } },
      include: {
        ...refundInclude,
        payment: { select: { method: true } },
        order: { select: { orderCode: true, callNumber: true } },
      },
    });
    if (!refund) throw new NotFoundException('Refund not found in your branch');
    return refund;
  }

  async cancelPaidOrder(user: AuthenticatedUser, orderId: string, dto: CancelPaidOrderDto, approvalRequestId?: string) {
    if (
      ![AppRole.MANAGER, AppRole.CASHIER].includes(user.role) ||
      !user.branchId ||
      !user.employeeId
    ) {
      throw new ForbiddenException('Assigned Store Manager or Cashier required');
    }
    if (dto.refundMethod !== RefundMethod.CASH)
      throw new BadRequestException('New refunds must be paid in cash');
    const reasonCode = dto.reasonCode ?? 'OTHER';
    if (
      !['CHANGE_OF_MIND', 'WRONG_ITEM', 'OUT_OF_STOCK', 'LONG_WAIT', 'OTHER'].includes(
        reasonCode,
      ) ||
      (reasonCode === 'OTHER' && dto.reason.trim().length < 5)
    )
      throw new BadRequestException('Valid refund reason required');
    const branchId = user.branchId;
    const employeeId = user.employeeId;
    const requestedItemIds = [...new Set(dto.orderItemIds ?? [])];
    const result = await this.prisma.$transaction(
      async (tx) => {
        const approval = approvalRequestId ? await (async () => {
          await tx.$queryRaw`SELECT id FROM refund_approval_requests WHERE id = ${approvalRequestId}::uuid FOR UPDATE`;
          const request = await tx.refundApprovalRequest.findFirst({ where: { id: approvalRequestId, branchId, orderId } });
          if (!request || request.status !== RefundApprovalStatus.APPROVED) throw new ConflictException('Refund request is no longer approved');
          const ids = Array.isArray(request.orderItemIds) ? request.orderItemIds : [];
          if (JSON.stringify(ids) !== JSON.stringify(requestedItemIds) || request.reason !== dto.reason)
            throw new ConflictException('Refund request details have changed');
          return request;
        })() : null;
        const candidate = await tx.payment.findFirst({
          where: {
            orderId,
            status: {
              in: [
                PaymentStatus.SUCCESS,
                PaymentStatus.AMOUNT_MISMATCH,
                PaymentStatus.REQUIRES_ATTENTION,
              ],
            },
          },
          orderBy: [{ status: 'desc' }, { createdAt: 'desc' }],
          select: { id: true },
        });
        if (!candidate) {
          throw new ConflictException('Order has no received payment to refund');
        }
        await tx.$queryRaw`SELECT id FROM payments WHERE id = ${candidate.id}::uuid FOR UPDATE`;
        const payment = await tx.payment.findUniqueOrThrow({ where: { id: candidate.id } });
        if (
          payment.status !== PaymentStatus.SUCCESS &&
          payment.status !== PaymentStatus.AMOUNT_MISMATCH &&
          !(
            payment.status === PaymentStatus.REQUIRES_ATTENTION &&
            [
              'PAYMENT_RECEIVED_AFTER_EXPIRY',
              'PAYMENT_RECEIVED_AFTER_CANCELLATION',
              'PAYMENT_RECEIVED_AFTER_SWITCH_TO_CASH',
            ].includes(payment.failureReason ?? '')
          )
        ) {
          throw new ConflictException('Payment is no longer eligible for a refund');
        }

        await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
        const order = await tx.order.findFirst({
          where: { id: orderId, branchId, type: OrderType.COUNTER_PICKUP },
          include: {
            branch: { select: { timezone: true } },
            items: { include: { units: true, refundItems: { select: { id: true } } } },
            refunds: { select: { amount: true, paymentId: true } },
          },
        });
        if (!order) throw new NotFoundException('Counter order was not found in your branch');
        if (
          user.role === AppRole.CASHIER && !approval &&
          (!order.paidAt ||
            this.businessDate('Asia/Ho_Chi_Minh', order.paidAt).getTime() !==
              this.businessDate('Asia/Ho_Chi_Minh', new Date()).getTime())
        ) {
          throw new ForbiddenException('Cashier can only refund payments received today');
        }
        const lateReturn =
          (user.role === AppRole.MANAGER || !!approval) &&
          payment.status === PaymentStatus.REQUIRES_ATTENTION &&
          ['PAYMENT_RECEIVED_AFTER_CANCELLATION', 'PAYMENT_RECEIVED_AFTER_SWITCH_TO_CASH'].includes(
            payment.failureReason ?? '',
          );
        if (
          !(cancellableOrderStatuses as OrderStatus[]).includes(order.status) &&
          !(lateReturn && order.status === 'CANCELLED')
        ) {
          throw new ConflictException('This order is not eligible for a paid-order refund');
        }
        if (
          payment.status === PaymentStatus.SUCCESS &&
          order.paymentStatus !== OrderPaymentStatus.PAID
        ) {
          throw new ConflictException('Order is no longer recorded as paid');
        }

        await tx.$queryRaw`SELECT id FROM order_items WHERE order_id = ${orderId}::uuid FOR UPDATE`;
        const activeItems = lateReturn
          ? []
          : order.items.filter(
              (item) => item.status !== OrderItemStatus.CANCELLED && item.refundItems.length === 0,
            );
        const cancelWholeOrder = requestedItemIds.length === 0;
        if (payment.status !== PaymentStatus.SUCCESS && !cancelWholeOrder) {
          throw new ConflictException('An underpaid order must be cancelled in full');
        }
        const rootItems = activeItems.filter((item) => !item.parentId);
        if (
          requestedItemIds.some((id) => activeItems.some((item) => item.id === id && item.parentId))
        )
          throw new BadRequestException('Refund the entire combo, not an individual component');
        const selectedItems = cancelWholeOrder
          ? rootItems
          : rootItems.filter((item) => requestedItemIds.includes(item.id));
        const selectedIds = new Set(selectedItems.map((item) => item.id));
        const cancelledItems = activeItems.filter(
          (item) => selectedIds.has(item.id) || (!!item.parentId && selectedIds.has(item.parentId)),
        );
        if (
          (!lateReturn && selectedItems.length === 0) ||
          (!cancelWholeOrder && selectedItems.length !== requestedItemIds.length)
        ) {
          throw new ConflictException(
            'One or more order lines are already cancelled or unavailable',
          );
        }

        const now = new Date();
        const actualReceived = payment.receivedAmount ?? payment.amount;
        const alreadyRefunded = order.refunds
          .filter((refund) => refund.paymentId === payment.id)
          .reduce((sum, refund) => sum.add(refund.amount), new Prisma.Decimal(0));
        const refundableBalance = actualReceived.sub(alreadyRefunded);
        const selectedTotal = selectedItems.reduce(
          (sum, item) => sum.add(item.totalPrice),
          new Prisma.Decimal(0),
        );
        const refundAmount = cancelWholeOrder
          ? refundableBalance
          : Prisma.Decimal.min(selectedTotal, refundableBalance);
        if (refundAmount.lte(0)) throw new ConflictException('Refund amount must be positive');
        if (approval && !refundAmount.eq(approval.amount))
          throw new ConflictException('Refund amount changed after approval; submit a new request');

        let remainingAllocation = refundAmount;
        const refundLines = selectedItems.map((item, index) => {
          const isLast = index === selectedItems.length - 1;
          const lineAmount = isLast
            ? remainingAllocation
            : Prisma.Decimal.min(item.totalPrice, remainingAllocation);
          remainingAllocation = Prisma.Decimal.max(0, remainingAllocation.sub(lineAmount));
          const isWastage =
            [OrderItemStatus.READY, OrderItemStatus.DELIVERED].some(
              (status) => status === item.status,
            ) ||
            item.units.some((unit) =>
              [OrderItemStatus.READY, OrderItemStatus.DELIVERED].some(
                (status) => status === unit.status,
              ),
            ) ||
            cancelledItems.some(
              (child) =>
                child.parentId === item.id &&
                ([OrderItemStatus.READY, OrderItemStatus.DELIVERED].some(
                  (status) => status === child.status,
                ) ||
                  child.units.some((unit) =>
                    [OrderItemStatus.READY, OrderItemStatus.DELIVERED].some(
                      (status) => status === unit.status,
                    ),
                  )),
            );
          return { item, lineAmount, isWastage };
        });

        for (const item of cancelledItems) {
          const restorable = item.units.length
            ? item.units.filter((unit) => unit.status === OrderItemStatus.QUEUED).length
            : item.status === OrderItemStatus.QUEUED
              ? item.quantity
              : 0;
          await tx.orderItemUnit.updateMany({
            where: { orderItemId: item.id, status: { not: OrderItemStatus.CANCELLED } },
            data: { status: OrderItemStatus.CANCELLED },
          });
          await tx.orderItem.update({
            where: { id: item.id },
            data: {
              status: OrderItemStatus.CANCELLED,
              cancelledAt: now,
              cancelledById: employeeId,
              cancellationReason: dto.reason,
            },
          });
          if (restorable > 0 && item.menuItemId) {
            await tx.branchMenuItem.updateMany({
              where: {
                branchId,
                menuItemId: item.menuItemId,
                remainingPortions: { not: null },
              },
              data: { remainingPortions: { increment: restorable } },
            });
          }
        }

        const remainingItems = rootItems.filter(
          (item) => !selectedItems.some((selected) => selected.id === item.id),
        );
        const fullCancellation = !lateReturn && remainingItems.length === 0;
        const nextOrderStatus = fullCancellation
          ? OrderStatus.CANCELLED
          : lateReturn
            ? order.status
            : [OrderStatus.COMPLETED, OrderStatus.DELIVERED].some(
                  (status) => status === order.status,
                )
              ? order.status
              : this.deriveOrderStatus(remainingItems);
        const updatedOrder = await tx.order.update({
          where: { id: order.id },
          data: {
            status: nextOrderStatus,
            ...(fullCancellation
              ? {
                  cancelledAt: now,
                  cancelledById: employeeId,
                  cancellationReason: dto.reason,
                }
              : {}),
          },
        });
        if (fullCancellation) {
          await tx.printJob.updateMany({
            where: { orderId: order.id, status: PrintJobStatus.PENDING },
            data: { status: PrintJobStatus.CANCELLED },
          });
        }

        const completedImmediately = dto.refundMethod === RefundMethod.CASH;
        const refund = await tx.refund.create({
          data: {
            orderId: order.id,
            paymentId: payment.id,
            amount: refundAmount,
            status: completedImmediately ? RefundStatus.COMPLETED : RefundStatus.PENDING,
            method: dto.refundMethod,
            sourceReference: lateReturn ? `late-payment:${payment.id}` : null,
            source: lateReturn
              ? RefundSource.LATE_PAYMENT
              : user.role === AppRole.CASHIER
                ? RefundSource.CASHIER_REFUND
                : RefundSource.MANAGER_CANCELLATION,
            reason: dto.reason,
            reasonCode,
            requestedByUserId: user.id,
            requestedByEmployeeId: employeeId,
            requestedByRole: user.role,
            requestedAt: now,
            cancellationDate: this.businessDate(order.branch.timezone, now),
            completedByUserId: completedImmediately ? user.id : null,
            completedByEmployeeId: completedImmediately ? employeeId : null,
            completedByRole: completedImmediately ? user.role : null,
            completedAt: completedImmediately ? now : null,
            items: {
              create: refundLines.map(({ item, lineAmount, isWastage }) => ({
                orderItemId: item.id,
                quantity: item.quantity,
                refundAmount: lineAmount,
                isWastage,
              })),
            },
          },
          include: refundInclude,
        });
        if (approval) {
          await tx.refundApprovalRequest.update({
            where: { id: approval.id },
            data: { status: RefundApprovalStatus.COMPLETED, refundId: refund.id, completedByUserId: user.id, completedByEmployeeId: employeeId, completedAt: now },
          });
        }
        if (lateReturn) {
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: PaymentStatus.SUCCESS, failureReason: null },
          });
          await tx.order.update({
            where: { id: order.id },
            data: { attentionAt: null, attentionReason: null },
          });
        }
        await writeBranchAudit(tx, user, {
          action: fullCancellation ? 'PAID_ORDER_CANCELLED' : 'PAID_ORDER_ITEMS_CANCELLED',
          entityType: 'ORDER',
          entityId: order.id,
          reason: dto.reason,
          before: { status: order.status, paymentStatus: order.paymentStatus },
          after: {
            status: nextOrderStatus,
            refundId: refund.id,
            refundStatus: refund.status,
            refundMethod: refund.method,
            refundAmount: refund.amount.toString(),
            cancelledItemIds: selectedItems.map((item) => item.id),
          },
        });
        return { order: updatedOrder, refund, fullCancellation };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    const payload = {
      orderId: result.order.id,
      reason: dto.reason,
      refundId: result.refund.id,
      refundStatus: result.refund.status,
      refundAmount: result.refund.amount.toString(),
      itemIds: result.refund.items.map((item) => item.orderItemId),
    };
    this.realtime.branch(branchId, 'refund.completed', payload);
    if (result.refund.source !== RefundSource.LATE_PAYMENT) {
      this.realtime.branch(branchId, 'order.cancelled', payload);
      this.realtime.callingDisplay(branchId, 'order.cancelled', payload);
    }
    if (result.refund.status === RefundStatus.PENDING) {
      this.realtime.branch(branchId, 'refund.pending', payload);
    }
    // BR-86: one refund slip PDF per refund, only after the refund transaction committed. A PDF or
    // storage failure is recorded on the document (FAILED, retryable) and never undoes the refund.
    const refundDocument = this.refundDocuments
      ? await this.refundDocuments.generateAfterCommit(result.refund.id)
      : { id: null, status: 'DISABLED' };
    return { ...result, refundDocument };
  }

  async completeRefund(user: AuthenticatedUser, refundId: string, dto: CompleteRefundDto) {
    if (user.role !== AppRole.OWNER) {
      throw new ForbiddenException('Only the Owner can settle a legacy bank-transfer refund');
    }
    const scopedRefund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      select: { order: { select: { branchId: true } } },
    });
    if (!scopedRefund) throw new NotFoundException('Refund not found');
    await this.assertRefundAccess(user, scopedRefund.order.branchId);
    const result = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM refunds WHERE id = ${refundId}::uuid FOR UPDATE`;
        const refund = await tx.refund.findUnique({
          where: { id: refundId },
          include: { order: { select: { branchId: true } }, ...refundInclude },
        });
        if (!refund) throw new NotFoundException('Refund not found');
        if (refund.status !== RefundStatus.PENDING) {
          throw new ConflictException('Only a pending refund can be completed');
        }
        if (refund.method !== RefundMethod.BANK_TRANSFER) {
          throw new ConflictException('Cash refunds are completed when the order is cancelled');
        }
        const now = new Date();
        const updated = await tx.refund.update({
          where: { id: refund.id },
          data: {
            status: RefundStatus.COMPLETED,
            completedByUserId: user.id,
            completedByEmployeeId: user.employeeId,
            completedByRole: user.role,
            completedAt: now,
            note: dto.note || null,
          },
          include: refundInclude,
        });
        if (user.role === AppRole.MANAGER) {
          await writeBranchAudit(tx, user, {
            action: 'REFUND_COMPLETED',
            entityType: 'REFUND',
            entityId: refund.id,
            reason: dto.note,
            before: { status: refund.status },
            after: { status: RefundStatus.COMPLETED, method: refund.method },
          });
        }
        return { branchId: refund.order.branchId, refund: updated };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    this.realtime.branch(result.branchId, 'refund.completed', {
      refundId: result.refund.id,
      orderId: result.refund.orderId,
      amount: result.refund.amount.toString(),
    });
    return result.refund;
  }

  private deriveOrderStatus(items: Array<{ status: OrderItemStatus }>) {
    if (items.some((item) => item.status === OrderItemStatus.OUT_OF_STOCK)) {
      return OrderStatus.REQUIRES_ATTENTION;
    }
    if (items.every((item) => item.status === OrderItemStatus.READY)) return OrderStatus.READY;
    if (
      items.some(
        (item) =>
          item.status === OrderItemStatus.PREPARING || item.status === OrderItemStatus.READY,
      )
    ) {
      return OrderStatus.PREPARING;
    }
    return OrderStatus.SUBMITTED;
  }

  /** Refund obligations remain actionable while a subscription or chain is suspended. */
  private async assertRefundAccess(user: AuthenticatedUser, branchId: string) {
    if (user.role === AppRole.MANAGER) {
      if (user.branchId !== branchId || !user.employeeId) {
        throw new ForbiddenException('You can only complete refunds for your assigned branch');
      }
      return;
    }
    if (user.role !== AppRole.OWNER || !user.ownerId) {
      throw new ForbiddenException('An Owner or assigned Store Manager is required');
    }
    const assignment = await this.prisma.ownerChainAssignment.count({
      where: {
        ownerId: user.ownerId,
        chain: {
          deletedAt: null,
          branches: { some: { id: branchId, deletedAt: null } },
        },
      },
    });
    if (!assignment) throw new ForbiddenException('Refund is outside your restaurant chain');
  }

  private businessDate(timezone: string, now: Date) {
    const value = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    return new Date(`${value}T00:00:00.000Z`);
  }
}
