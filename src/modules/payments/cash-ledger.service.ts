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
export interface LedgerQuery {
  from?: string;
  to?: string;
  direction?: CashLedgerDirection;
  sourceType?: CashLedgerSourceType;
  paymentMethod?: PaymentMethod;
  cashierId?: string;
  page?: number;
  pageSize?: number;
}

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
          // BR-81: money returned at the counter is always a cash outflow,
          // regardless of how the original order was paid.
          paymentMethod: PaymentMethod.CASH,
        },
      ],
    });
  }

  async listBranch(user: AuthenticatedUser, branchId: string, query: LedgerQuery = {}) {
    await this.access.assertCanAccessBranch(user, branchId);
    return this.list({ branchId, ...this.filters(query) }, query, false);
  }

  async listChain(user: AuthenticatedUser, chainId: string, query: LedgerQuery = {}) {
    if (user.role !== 'OWNER') throw new ForbiddenException('Brand Manager required');
    const assigned = await this.prisma.ownerChainAssignment.count({
      where: { ownerId: user.ownerId ?? '', chainId },
    });
    if (!assigned) throw new ForbiddenException('Chain is outside your assigned scope');
    return this.list({ chainId, ...this.filters(query) }, query, true);
  }

  private async list(
    where: Prisma.CashLedgerEntryWhereInput,
    query: LedgerQuery,
    byBranch: boolean,
  ) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const [rows, total, aggregate, branchAggregate] = await this.prisma.$transaction([
      this.prisma.cashLedgerEntry.findMany({
        where,
        include: {
          branch: { select: { id: true, code: true, name: true } },
          order: { select: { orderCode: true, callNumber: true, businessDate: true } },
          payment: {
            select: {
              processedBy: {
                select: { id: true, employeeCode: true, firstName: true, lastName: true },
              },
            },
          },
          refund: {
            select: {
              reason: true,
              note: true,
              completedByEmployeeId: true,
              requestedByEmployeeId: true,
            },
          },
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.cashLedgerEntry.count({ where }),
      this.prisma.cashLedgerEntry.groupBy({
        by: ['direction', 'paymentMethod'],
        where,
        orderBy: [{ direction: 'asc' }, { paymentMethod: 'asc' }],
        _sum: { amount: true },
      }),
      this.prisma.cashLedgerEntry.groupBy({
        by: ['branchId', 'direction', 'paymentMethod'],
        where,
        orderBy: [{ branchId: 'asc' }, { direction: 'asc' }, { paymentMethod: 'asc' }],
        _sum: { amount: true },
      }),
    ]);
    const summary = this.summary(aggregate);
    const refundActorIds = [
      ...new Set(
        rows
          .flatMap((entry) => [
            entry.refund?.completedByEmployeeId,
            entry.refund?.requestedByEmployeeId,
          ])
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const refundActors = refundActorIds.length
      ? await this.prisma.employee.findMany({
          where: { id: { in: refundActorIds } },
          select: { id: true, employeeCode: true, firstName: true, lastName: true },
        })
      : [];
    const refundActorById = new Map(refundActors.map((actor) => [actor.id, actor]));
    const items = rows.map((entry) => {
      let actor = entry.payment?.processedBy ?? null;
      if (entry.direction === CashLedgerDirection.OUTFLOW && entry.refund) {
        const employeeId = entry.refund.completedByEmployeeId ?? entry.refund.requestedByEmployeeId;
        actor = employeeId ? (refundActorById.get(employeeId) ?? null) : null;
      }
      return {
        id: entry.id,
        direction: entry.direction,
        sourceType: entry.sourceType,
        paymentMethod: entry.paymentMethod,
        amount: entry.amount,
        occurredAt: entry.occurredAt,
        occurredAtVietnam: this.vietnamTime(entry.occurredAt),
        businessDate: entry.order?.businessDate,
        branch: entry.branch,
        orderCode: entry.order?.orderCode ?? null,
        callNumber: entry.order?.callNumber ?? null,
        actor,
        refundReason: entry.refund?.reason ?? null,
        note: entry.refund?.note ?? entry.refund?.reason ?? null,
      };
    });
    const branchIds = [...new Set(branchAggregate.map((row) => row.branchId))];
    const branches = byBranch
      ? await this.prisma.branch.findMany({
          where: { id: { in: branchIds } },
          select: { id: true, code: true, name: true },
        })
      : [];
    return {
      items,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
      summary,
      branches: branches.map((branch) => ({
        branch,
        summary: this.summary(branchAggregate.filter((row) => row.branchId === branch.id)),
      })),
    };
  }

  private filters(query: LedgerQuery): Prisma.CashLedgerEntryWhereInput {
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    return {
      ...(from || to
        ? { occurredAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
      ...(query.direction ? { direction: query.direction } : {}),
      ...(query.sourceType ? { sourceType: query.sourceType } : {}),
      ...(query.paymentMethod ? { paymentMethod: query.paymentMethod } : {}),
      ...(query.cashierId
        ? {
            OR: [
              { payment: { processedById: query.cashierId } },
              {
                refund: {
                  OR: [
                    { completedByEmployeeId: query.cashierId },
                    { requestedByEmployeeId: query.cashierId },
                  ],
                },
              },
            ],
          }
        : {}),
    };
  }

  private summary(
    rows: Array<{
      direction: CashLedgerDirection;
      paymentMethod: PaymentMethod | null;
      _sum?: { amount?: Prisma.Decimal | null };
    }>,
  ) {
    const sum = (direction: CashLedgerDirection, method?: PaymentMethod) =>
      rows
        .filter((row) => row.direction === direction && (!method || row.paymentMethod === method))
        .reduce((total, row) => total.add(row._sum?.amount ?? 0), new Prisma.Decimal(0));
    const cashCollected = sum(CashLedgerDirection.INFLOW, PaymentMethod.CASH);
    const qrCollected = sum(CashLedgerDirection.INFLOW).sub(cashCollected);
    const cashRefunded = sum(CashLedgerDirection.OUTFLOW);
    return {
      cashCollected,
      qrCollected,
      cashRefunded,
      netCash: cashCollected.sub(cashRefunded),
      netTotal: cashCollected.add(qrCollected).sub(cashRefunded),
      // Kept for clients already using the first ledger contract.
      inflow: cashCollected.add(qrCollected),
      outflow: cashRefunded,
      net: cashCollected.add(qrCollected).sub(cashRefunded),
    };
  }

  private vietnamTime(value: Date) {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Ho_Chi_Minh',
      dateStyle: 'short',
      timeStyle: 'medium',
      hour12: false,
    }).format(value);
  }
}
