import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  OrderPaymentStatus,
  OrderStatus,
  OrderType,
  OrderItemStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  TableSessionStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AppRole } from '../auth/app-role.enum.js';
import { writeBranchAudit } from '../branch-manager/manager-scope.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import type {
  ConfirmPaymentDto,
  CreateTableSessionPaymentDto,
  PaymentListQueryDto,
} from './dto/payment.dto.js';

const paymentInclude = {
  processedBy: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
  tableSession: {
    select: {
      id: true,
      sessionCode: true,
      branchId: true,
      guestName: true,
      guestCount: true,
      status: true,
      tables: {
        where: { releasedAt: null },
        select: { table: { select: { id: true, code: true, name: true } } },
      },
    },
  },
  order: { select: { id: true, orderCode: true, branchId: true, totalAmount: true, type: true } },
} satisfies Prisma.PaymentInclude;

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  async list(branchId: string, query: PaymentListQueryDto, user: AuthenticatedUser) {
    await this.branchAccess.assertCanAccessBranch(user, branchId);
    const createdAt = {
      ...(query.from ? { gte: new Date(query.from) } : {}),
      ...(query.to ? { lte: new Date(query.to) } : {}),
    };
    const where: Prisma.PaymentWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to ? { createdAt } : {}),
      OR: [{ tableSession: { branchId } }, { order: { branchId } }],
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        include: paymentInclude,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.payment.count({ where }),
    ]);
    return { items, total, page: query.page, limit: query.limit };
  }

  async get(paymentId: string, user: AuthenticatedUser) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: paymentInclude,
    });
    if (!payment) throw new NotFoundException('Payment not found');
    await this.branchAccess.assertCanAccessBranch(user, this.branchIdOf(payment));
    return payment;
  }

  async createForTableSession(
    tableSessionId: string,
    dto: CreateTableSessionPaymentDto,
    user: AuthenticatedUser,
  ) {
    const actor = this.employee(user);
    const session = await this.prisma.tableSession.findFirst({
      where: {
        id: tableSessionId,
        branchId: actor.branchId,
        status: { in: [TableSessionStatus.OPEN, TableSessionStatus.SERVING] },
      },
      select: { id: true, paymentStatus: true },
    });
    if (!session) throw new NotFoundException('Open table session was not found in your branch');
    if (session.paymentStatus === OrderPaymentStatus.PAID) {
      throw new ConflictException('Table session is already fully paid');
    }
    const [orders, successfulPayments] = await Promise.all([
      this.prisma.order.findMany({
        where: { tableSessionId, status: { not: OrderStatus.CANCELLED } },
        select: { totalAmount: true },
      }),
      this.prisma.payment.findMany({
        where: { tableSessionId, status: PaymentStatus.SUCCESS },
        select: { amount: true },
      }),
    ]);
    const totalDue = orders.reduce(
      (sum, order) => sum.add(order.totalAmount),
      new Prisma.Decimal(0),
    );
    const totalPaid = successfulPayments.reduce(
      (sum, payment) => sum.add(payment.amount),
      new Prisma.Decimal(0),
    );
    if (totalDue.lessThanOrEqualTo(0)) {
      throw new ConflictException('Table session has no payable balance');
    }
    if (totalPaid.add(dto.amount).greaterThan(totalDue)) {
      throw new ConflictException('Payment amount exceeds the remaining balance');
    }
    return this.prisma.payment.create({
      data: {
        paymentCode: `PAY-${Date.now()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        tableSessionId,
        method: dto.method,
        amount: dto.amount,
        transactionRef: dto.transactionRef,
        note: dto.note,
      },
      include: paymentInclude,
    });
  }

  async confirm(paymentId: string, dto: ConfirmPaymentDto, user: AuthenticatedUser) {
    const actor = this.employee(user);
    if (user.role !== AppRole.MANAGER && user.role !== AppRole.CASHIER)
      throw new ForbiddenException('Only MANAGER or CASHIER can confirm payments');
    await this.branchAccess.assertCanAccessBranch(user, actor.branchId);
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const payment = await tx.payment.findUnique({
            where: { id: paymentId },
            include: paymentInclude,
          });
          if (!payment) throw new NotFoundException('Payment not found');
          if (this.branchIdOf(payment) !== actor.branchId) {
            throw new ForbiddenException('Payment does not belong to your assigned branch');
          }
          const manual = payment.method !== PaymentMethod.CASH;
          if (manual && user.role !== AppRole.MANAGER)
            throw new ForbiddenException('Only MANAGER can manually confirm non-cash payments');
          if (
            manual &&
            (!dto.reason || dto.reason.trim().length < 3 || dto.reason.trim().length > 500)
          )
            throw new BadRequestException(
              'A manual confirmation reason of 3 to 500 characters is required',
            );
          if (
            manual &&
            (dto.receivedAmount == null ||
              !Number.isFinite(dto.receivedAmount) ||
              dto.receivedAmount <= 0)
          )
            throw new BadRequestException('Actual received amount is required');
          if (payment.status !== PaymentStatus.PENDING) {
            throw new ConflictException('Only a pending payment can be confirmed');
          }
          if (
            payment.tableSession &&
            payment.tableSession.status !== TableSessionStatus.OPEN &&
            payment.tableSession.status !== TableSessionStatus.SERVING
          ) {
            throw new ConflictException('The table session is no longer open for payment');
          }

          await this.assertPaymentDoesNotExceedBalance(tx, payment);

          const order = payment.orderId
            ? await tx.order.findUniqueOrThrow({
                where: { id: payment.orderId },
                include: { items: true, branch: { select: { timezone: true } } },
              })
            : null;
          if (
            order &&
            (order.status === OrderStatus.CANCELLED ||
              order.paymentStatus === OrderPaymentStatus.PAID)
          )
            throw new ConflictException('Order is cancelled or already paid');
          if (
            order?.type === OrderType.COUNTER_PICKUP &&
            (order.status !== OrderStatus.CONFIRMED ||
              order.paymentStatus !== OrderPaymentStatus.UNPAID ||
              !payment.amount.equals(order.totalAmount))
          ) {
            throw new ConflictException('Counter order must await a full payment');
          }

          const paidAt = new Date();
          const confirmed = await tx.payment.update({
            where: { id: paymentId },
            data: {
              status: PaymentStatus.SUCCESS,
              paidAt,
              confirmedAt: paidAt,
              confirmationReason: manual ? dto.reason!.trim() : null,
              receivedAmount: manual ? dto.receivedAmount : payment.amount,
              processedById: actor.employeeId,
              transactionRef: dto.transactionRef ?? payment.transactionRef,
            },
            include: paymentInclude,
          });

          if (payment.tableSessionId) {
            await this.refreshTableSessionPaymentState(tx, payment.tableSessionId, paidAt);
          } else if (order?.type === OrderType.COUNTER_PICKUP) {
            const localDate = new Intl.DateTimeFormat('en-CA', {
              timeZone: order.branch.timezone,
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
            }).format(paidAt);
            const businessDate = new Date(`${localDate}T00:00:00Z`);
            const sequence = await tx.branchDailySequence.upsert({
              where: { branchId_businessDate: { branchId: actor.branchId, businessDate } },
              create: { branchId: actor.branchId, businessDate, nextNumber: 1 },
              update: { nextNumber: { increment: 1 } },
            });
            for (const item of order.items) {
              await tx.orderItem.update({
                where: { id: item.id },
                data: {
                  status: OrderItemStatus.QUEUED,
                  queuedAt: paidAt,
                  units: {
                    create: Array.from({ length: item.quantity }, (_, index) => ({
                      sequence: index + 1,
                      status: OrderItemStatus.QUEUED,
                    })),
                  },
                },
              });
            }
            await tx.order.update({
              where: { id: order.id },
              data: {
                status: OrderStatus.SUBMITTED,
                paymentStatus: OrderPaymentStatus.PAID,
                paidAt,
                submittedAt: paidAt,
                businessDate,
                callNumber: sequence.nextNumber,
              },
            });
          } else if (payment.orderId) {
            await this.refreshOrderPaymentState(tx, payment.orderId, paidAt);
          }
          await writeBranchAudit(tx, user, {
            action: manual ? 'PAYMENT_MANUALLY_CONFIRMED' : 'CASH_PAYMENT_CONFIRMED',
            entityType: 'PAYMENT',
            entityId: payment.id,
            reason: manual ? dto.reason!.trim() : undefined,
            before: {
              status: payment.status,
              processedById: payment.processedById,
              amount: payment.amount.toString(),
            },
            after: {
              status: 'SUCCESS',
              amount: payment.amount.toString(),
              receivedAmount: confirmed.receivedAmount!.toString(),
              variance: confirmed.receivedAmount!.minus(payment.amount).toString(),
              transactionRef: confirmed.transactionRef,
              orderId: payment.orderId,
              tableSessionId: payment.tableSessionId,
            },
          });
          return confirmed;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034')
        throw new ConflictException('Payment changed concurrently; reload before retrying');
      throw error;
    }
  }

  private employee(user: AuthenticatedUser): { employeeId: string; branchId: string } {
    if (!user.employeeId || !user.branchId) {
      throw new ForbiddenException('An assigned employee profile is required');
    }
    return { employeeId: user.employeeId, branchId: user.branchId };
  }

  private branchIdOf(payment: {
    tableSession: { branchId: string } | null;
    order: { branchId: string } | null;
  }): string {
    const branchId = payment.tableSession?.branchId ?? payment.order?.branchId;
    if (!branchId) throw new ConflictException('Payment is not linked to a payable record');
    return branchId;
  }

  private async refreshTableSessionPaymentState(
    tx: Prisma.TransactionClient,
    tableSessionId: string,
    paidAt: Date,
  ) {
    const [orders, payments] = await Promise.all([
      tx.order.findMany({
        where: { tableSessionId, status: { not: OrderStatus.CANCELLED } },
        select: { id: true, totalAmount: true },
      }),
      tx.payment.findMany({
        where: { tableSessionId, status: PaymentStatus.SUCCESS },
        select: { amount: true },
      }),
    ]);
    const totalDue = orders.reduce(
      (sum, order) => sum.add(order.totalAmount),
      new Prisma.Decimal(0),
    );
    const totalPaid = payments.reduce(
      (sum, payment) => sum.add(payment.amount),
      new Prisma.Decimal(0),
    );
    const status = totalPaid.greaterThanOrEqualTo(totalDue)
      ? OrderPaymentStatus.PAID
      : OrderPaymentStatus.PARTIALLY_PAID;
    await tx.tableSession.update({
      where: { id: tableSessionId },
      data: {
        paymentStatus: status,
        status:
          status === OrderPaymentStatus.PAID ? TableSessionStatus.PAID : TableSessionStatus.SERVING,
        paidAt: status === OrderPaymentStatus.PAID ? paidAt : null,
      },
    });
    await tx.order.updateMany({
      where: { tableSessionId, status: { not: OrderStatus.CANCELLED } },
      data: {
        paymentStatus: status,
        ...(status === OrderPaymentStatus.PAID
          ? { status: OrderStatus.COMPLETED, completedAt: paidAt, paidAt }
          : {}),
      },
    });
  }

  private async refreshOrderPaymentState(
    tx: Prisma.TransactionClient,
    orderId: string,
    paidAt: Date,
  ) {
    const [order, payments] = await Promise.all([
      tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { totalAmount: true } }),
      tx.payment.findMany({
        where: { orderId, status: PaymentStatus.SUCCESS },
        select: { amount: true },
      }),
    ]);
    const totalPaid = payments.reduce(
      (sum, payment) => sum.add(payment.amount),
      new Prisma.Decimal(0),
    );
    await tx.order.update({
      where: { id: orderId },
      data: {
        paidAt: totalPaid.greaterThanOrEqualTo(order.totalAmount) ? paidAt : null,
        paymentStatus: totalPaid.greaterThanOrEqualTo(order.totalAmount)
          ? OrderPaymentStatus.PAID
          : OrderPaymentStatus.PARTIALLY_PAID,
      },
    });
  }

  private async assertPaymentDoesNotExceedBalance(
    tx: Prisma.TransactionClient,
    payment: {
      id: string;
      amount: Prisma.Decimal;
      tableSessionId: string | null;
      orderId: string | null;
    },
  ) {
    const successful = await tx.payment.findMany({
      where: {
        id: { not: payment.id },
        status: PaymentStatus.SUCCESS,
        ...(payment.tableSessionId
          ? { tableSessionId: payment.tableSessionId }
          : { orderId: payment.orderId }),
      },
      select: { amount: true },
    });
    const paid = successful.reduce((sum, item) => sum.add(item.amount), new Prisma.Decimal(0));
    const due = payment.tableSessionId
      ? (
          await tx.order.aggregate({
            where: {
              tableSessionId: payment.tableSessionId,
              status: { not: OrderStatus.CANCELLED },
            },
            _sum: { totalAmount: true },
          })
        )._sum.totalAmount
      : (
          await tx.order.findUniqueOrThrow({
            where: { id: payment.orderId! },
            select: { totalAmount: true },
          })
        ).totalAmount;
    if (!due || paid.add(payment.amount).greaterThan(due)) {
      throw new ConflictException('Payment amount exceeds the remaining balance');
    }
  }
}
