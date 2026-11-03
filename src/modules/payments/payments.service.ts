import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaymentMethod, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AppRole } from '../auth/app-role.enum.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import { CounterPaymentSettlementService } from './counter-payment-settlement.service.js';
import type { ConfirmPaymentDto, PaymentListQueryDto } from './dto/payment.dto.js';

const paymentInclude = {
  processedBy: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
  order: { select: { id: true, orderCode: true, branchId: true, totalAmount: true, type: true } },
} satisfies Prisma.PaymentInclude;

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branchAccess: BranchAccessService,
    private readonly counterSettlement: CounterPaymentSettlementService,
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
      order: { branchId, type: 'COUNTER_PICKUP' },
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

  async confirm(paymentId: string, dto: ConfirmPaymentDto, user: AuthenticatedUser) {
    const actor = this.employee(user);
    if (user.role !== AppRole.MANAGER)
      throw new ForbiddenException('Only MANAGER can manually confirm bank transfers');
    await this.branchAccess.assertCanAccessBranch(user, actor.branchId);
    if (!dto.reason || dto.reason.trim().length < 3 || dto.reason.trim().length > 500)
      throw new BadRequestException(
        'A manual confirmation reason of 3 to 500 characters is required',
      );
    if (
      dto.receivedAmount == null ||
      !Number.isFinite(dto.receivedAmount) ||
      dto.receivedAmount <= 0
    )
      throw new BadRequestException('Actual received amount is required');
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: paymentInclude,
    });
    if (!payment) throw new NotFoundException('Payment not found');
    if (this.branchIdOf(payment) !== actor.branchId)
      throw new ForbiddenException('Payment does not belong to your assigned branch');
    if (payment.method !== PaymentMethod.BANK_TRANSFER)
      throw new ConflictException('Only bank transfers can be confirmed manually');
    try {
      const result = await this.counterSettlement.settle({
        paymentId,
        source: 'MANAGER_MANUAL',
        receivedAmount: dto.receivedAmount,
        transactionRef: dto.transactionRef,
        actor: user,
        reason: dto.reason,
      });
      return { ...result.payment, order: result.order, tracking: result.tracking };
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : undefined;
      if (code && ['P2002', 'P2028', 'P2034'].includes(code))
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

  private branchIdOf(payment: { order: { branchId: string; type: string } | null }): string {
    const branchId = payment.order?.branchId;
    if (!branchId || payment.order?.type !== 'COUNTER_PICKUP')
      throw new NotFoundException('Counter payment not found');
    return branchId;
  }
}
