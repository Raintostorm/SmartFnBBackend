import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  OrderPaymentStatus,
  OrderStatus,
  PaymentStatus,
  Prisma,
  TableSessionStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
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
  order: { select: { id: true, orderCode: true, branchId: true, totalAmount: true } },
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
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
        include: paymentInclude,
      });
      if (!payment) throw new NotFoundException('Payment not found');
      if (this.branchIdOf(payment) !== actor.branchId) {
        throw new ForbiddenException('Payment does not belong to your assigned branch');
      }
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

      const paidAt = new Date();
      const confirmed = await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.SUCCESS,
          paidAt,
          processedById: actor.employeeId,
          transactionRef: dto.transactionRef ?? payment.transactionRef,
        },
        include: paymentInclude,
      });

      if (payment.tableSessionId) {
        await this.refreshTableSessionPaymentState(tx, payment.tableSessionId, paidAt);
      } else if (payment.orderId) {
        await this.refreshOrderPaymentState(tx, payment.orderId);
      }
      return confirmed;
    });
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
          ? { status: OrderStatus.COMPLETED, completedAt: paidAt }
          : {}),
      },
    });
  }

  private async refreshOrderPaymentState(tx: Prisma.TransactionClient, orderId: string) {
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
