import { ConflictException, Injectable } from '@nestjs/common';
import {
  OrderItemStatus,
  OrderPaymentStatus,
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentStatus,
  PrintDocumentType,
  Prisma,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { RealtimePublisher } from '../../realtime/realtime.publisher.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { writeBranchAudit } from '../branch-manager/manager-scope.js';
import { OrderTrackingService } from '../order-tracking/order-tracking.service.js';

export type CounterSettlementSource = 'PAYOS_WEBHOOK' | 'PAYOS_RECHECK' | 'MANAGER_MANUAL';

export interface SettleCounterPaymentInput {
  paymentId: string;
  source: CounterSettlementSource;
  receivedAmount: string | number | Prisma.Decimal;
  providerTransactionId?: string;
  transactionRef?: string;
  actor?: AuthenticatedUser;
  reason?: string;
}

@Injectable()
export class CounterPaymentSettlementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tracking: OrderTrackingService,
    private readonly realtime: RealtimePublisher,
  ) {}

  async markAmountMismatch(
    paymentId: string,
    receivedAmount: string | number | Prisma.Decimal,
    providerTransactionId?: string,
  ) {
    const received = new Prisma.Decimal(receivedAmount);
    const result = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
        const payment = await tx.payment.findUnique({
          where: { id: paymentId },
          include: { order: { select: { id: true, branchId: true, status: true } } },
        });
        if (!payment?.order) throw new ConflictException('Counter payment has no order');
        if (payment.status === PaymentStatus.SUCCESS) return { changed: false, payment };
        if (
          payment.status !== PaymentStatus.PENDING &&
          payment.status !== PaymentStatus.AMOUNT_MISMATCH
        ) {
          throw new ConflictException('Payment is no longer awaiting reconciliation');
        }
        const updated = await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.AMOUNT_MISMATCH,
            receivedAmount: received,
            providerTransactionId: providerTransactionId ?? payment.providerTransactionId,
            failureReason: null,
          },
          include: { order: { select: { id: true, branchId: true, status: true } } },
        });
        if (
          payment.order.status === OrderStatus.CONFIRMED ||
          payment.order.status === OrderStatus.REQUIRES_ATTENTION
        ) {
          await tx.order.update({
            where: { id: payment.order.id },
            data: { status: OrderStatus.REQUIRES_ATTENTION },
          });
        }
        return { changed: payment.status !== PaymentStatus.AMOUNT_MISMATCH, payment: updated };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    if (result.changed && result.payment.order) {
      this.realtime.branch(result.payment.order.branchId, 'manager.order.attention-required', {
        reason: 'PAYMENT_AMOUNT_MISMATCH',
        orderId: result.payment.order.id,
        paymentId: result.payment.id,
        expectedAmount: result.payment.amount.toString(),
        receivedAmount: received.toString(),
      });
    }
    return result.payment;
  }

  async settle(input: SettleCounterPaymentInput) {
    const received = new Prisma.Decimal(input.receivedAmount);
    const result = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM payments WHERE id = ${input.paymentId}::uuid FOR UPDATE`;
        const payment = await tx.payment.findUnique({
          where: { id: input.paymentId },
          include: {
            order: { include: { items: true, branch: { select: { timezone: true } } } },
          },
        });
        if (!payment?.order || payment.order.type !== OrderType.COUNTER_PICKUP) {
          throw new ConflictException('Payment is not linked to a counter order');
        }
        await tx.$queryRaw`SELECT id FROM orders WHERE id = ${payment.order.id}::uuid FOR UPDATE`;
        if (
          payment.status !== PaymentStatus.PENDING &&
          payment.status !== PaymentStatus.AMOUNT_MISMATCH
        ) {
          throw new ConflictException('PAYMENT_ALREADY_SETTLED');
        }
        if (input.source === 'MANAGER_MANUAL') {
          if (payment.method !== PaymentMethod.BANK_TRANSFER) {
            throw new ConflictException('Only bank transfers can be confirmed manually');
          }
          if (received.lessThan(payment.amount)) {
            throw new ConflictException({
              statusCode: 409,
              error: 'PAYMENT_AMOUNT_INSUFFICIENT',
              message: 'Số tiền thực nhận thấp hơn tổng tiền đơn hàng.',
            });
          }
        } else if (!received.equals(payment.amount)) {
          throw new ConflictException('Provider amount must match before automatic settlement');
        }
        const order = payment.order;
        if (
          order.paymentStatus !== OrderPaymentStatus.UNPAID ||
          (order.status !== OrderStatus.CONFIRMED &&
            order.status !== OrderStatus.REQUIRES_ATTENTION)
        ) {
          throw new ConflictException('Order is no longer awaiting payment');
        }
        const now = new Date();
        const businessDate = this.businessDate(order.branch.timezone, now);
        const sequence = await tx.branchDailySequence.upsert({
          where: { branchId_businessDate: { branchId: order.branchId, businessDate } },
          create: { branchId: order.branchId, businessDate, nextNumber: 1 },
          update: { nextNumber: { increment: 1 } },
        });
        const actorEmployeeId = input.actor?.employeeId ?? payment.processedById;
        if (!actorEmployeeId) throw new ConflictException('Payment has no responsible employee');
        const updatedPayment = await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.SUCCESS,
            paidAt: now,
            confirmedAt: now,
            receivedAmount: received,
            processedById: actorEmployeeId,
            providerTransactionId: input.providerTransactionId ?? payment.providerTransactionId,
            transactionRef: input.transactionRef ?? payment.transactionRef,
            confirmationReason: input.source === 'MANAGER_MANUAL' ? input.reason!.trim() : null,
            failureReason: null,
          },
        });
        for (const item of order.items) {
          await tx.orderItem.update({
            where: { id: item.id },
            data: {
              status: OrderItemStatus.QUEUED,
              queuedAt: now,
              units: {
                create: Array.from({ length: item.quantity }, (_, index) => ({
                  sequence: index + 1,
                  status: OrderItemStatus.QUEUED,
                })),
              },
            },
          });
        }
        const updatedOrder = await tx.order.update({
          where: { id: order.id },
          data: {
            status: OrderStatus.SUBMITTED,
            paymentStatus: OrderPaymentStatus.PAID,
            paidAt: now,
            submittedAt: now,
            businessDate,
            callNumber: sequence.nextNumber,
          },
        });
        const tracking = await this.tracking.ensureForOrder(tx, order.id);
        await tx.printJob.createMany({
          data: [PrintDocumentType.RECEIPT, PrintDocumentType.QUEUE_TICKET].map((type) => ({
            orderId: order.id,
            branchId: order.branchId,
            stationId: payment.stationId,
            type,
            printedById: actorEmployeeId,
          })),
        });
        if (input.actor) {
          await writeBranchAudit(tx, input.actor, {
            action: 'PAYMENT_MANUALLY_CONFIRMED',
            entityType: 'PAYMENT',
            entityId: payment.id,
            reason: input.reason!.trim(),
            before: {
              status: payment.status,
              amount: payment.amount.toString(),
              receivedAmount: payment.receivedAmount?.toString() ?? null,
            },
            after: {
              status: PaymentStatus.SUCCESS,
              amount: payment.amount.toString(),
              receivedAmount: received.toString(),
              changeDue: received.minus(payment.amount).toString(),
              orderId: order.id,
              callNumber: sequence.nextNumber,
            },
          });
        }
        return {
          payment: updatedPayment,
          order: updatedOrder,
          tracking,
          source: input.source,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    const event = {
      paymentId: result.payment.id,
      orderId: result.order.id,
      status: result.payment.status,
      callNumber: result.order.callNumber,
      source: result.source,
    };
    this.realtime.branch(result.order.branchId, 'payment.confirmed', event);
    this.realtime.branch(result.order.branchId, 'preparation.order.queued', event);
    this.realtime.callingDisplay(result.order.branchId, 'calling.order.queued', {
      id: result.order.id,
      orderCode: result.order.orderCode,
      callNumber: result.order.callNumber,
      status: result.order.status,
      submittedAt: result.order.submittedAt,
    });
    return result;
  }

  private businessDate(timezone: string, at: Date) {
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
    return new Date(`${date}T00:00:00.000Z`);
  }
}
