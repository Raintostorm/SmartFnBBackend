import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  CashLedgerDirection,
  CashLedgerSourceType,
  PaymentMethod,
  Prisma,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { BranchAccessService } from '../branches/branch-access.service.js';

type LedgerTx = Prisma.TransactionClient;

@Injectable()
export class CashLedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BranchAccessService,
  ) {}

  recordSale(
    tx: LedgerTx,
    input: {
      branchId: string;
      chainId: string;
      orderId: string;
      paymentId: string;
      amount: Prisma.Decimal;
      method: PaymentMethod;
      source: Exclude<CashLedgerSourceType, 'REFUND'>;
      occurredAt: Date;
    },
  ) {
    return tx.cashLedgerEntry.createMany({
      skipDuplicates: true,
      data: [
        {
          chainId: input.chainId,
          branchId: input.branchId,
          orderId: input.orderId,
          paymentId: input.paymentId,
          direction: CashLedgerDirection.INFLOW,
          sourceType: input.source,
          sourceId: input.paymentId,
          paymentMethod: input.method,
          amount: input.amount,
          occurredAt: input.occurredAt,
        },
      ],
    });
  }

  recordRefund(
    tx: LedgerTx,
    input: {
      branchId: string;
      chainId: string;
      orderId: string;
      paymentId: string;
      refundId: string;
      amount: Prisma.Decimal;
      method: PaymentMethod;
      occurredAt: Date;
    },
  ) {
    return tx.cashLedgerEntry.createMany({
      skipDuplicates: true,
      data: [
        {
          branchId: input.branchId,
          chainId: input.chainId,
          orderId: input.orderId,
          paymentId: input.paymentId,
          refundId: input.refundId,
          amount: input.amount,
          occurredAt: input.occurredAt,
          direction: CashLedgerDirection.OUTFLOW,
          sourceType: CashLedgerSourceType.REFUND,
          sourceId: input.refundId,
          paymentMethod: input.method,
        },
      ],
    });
  }

  async listBranch(user: AuthenticatedUser, branchId: string, from?: Date, to?: Date) {
    await this.access.assertCanAccessBranch(user, branchId);
    return this.list({ branchId, occurredAt: this.range(from, to) });
  }

  async listChain(user: AuthenticatedUser, chainId: string, from?: Date, to?: Date) {
    if (user.role !== 'OWNER') throw new ForbiddenException('Brand Manager required');
    const assigned = await this.prisma.ownerChainAssignment.count({
      where: { ownerId: user.ownerId ?? '', chainId },
    });
    if (!assigned) throw new ForbiddenException('Chain is outside your assigned scope');
    return this.list({ chainId, occurredAt: this.range(from, to) });
  }

  private async list(where: Prisma.CashLedgerEntryWhereInput) {
    const [items, aggregate] = await this.prisma.$transaction([
      this.prisma.cashLedgerEntry.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: 500,
      }),
      this.prisma.cashLedgerEntry.groupBy({
        by: ['direction'],
        where,
        orderBy: { direction: 'asc' },
        _sum: { amount: true },
      }),
    ]);
    const inflow =
      aggregate.find((row) => row.direction === CashLedgerDirection.INFLOW)?._sum?.amount ??
      new Prisma.Decimal(0);
    const outflow =
      aggregate.find((row) => row.direction === CashLedgerDirection.OUTFLOW)?._sum?.amount ??
      new Prisma.Decimal(0);
    return { items, summary: { inflow, outflow, net: inflow.sub(outflow) } };
  }

  private range(from?: Date, to?: Date): Prisma.DateTimeFilter | undefined {
    return from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } : undefined;
  }
}
