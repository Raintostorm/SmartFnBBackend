import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BusinessSubscriptionStatus,
  Prisma,
  RestaurantChainStatus,
  WalletLedgerEntryType,
  WalletStatus,
  WithdrawalRequestStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import type {
  ConfirmWithdrawalTransferDto,
  CreateWithdrawalRequestDto,
  ListWithdrawalRequestsQueryDto,
  PaginationQueryDto,
  UpdatePlatformFinanceConfigDto,
} from './dto/platform-admin.dto.js';

const FINANCE_CONFIG_ID = 'DEFAULT';

const withdrawalSelect = {
  id: true,
  amount: true,
  status: true,
  bankName: true,
  bankAccountName: true,
  bankAccountNumber: true,
  rejectionReason: true,
  reviewedAt: true,
  bankTransactionCode: true,
  transferFailureReason: true,
  transferredAt: true,
  createdAt: true,
  updatedAt: true,
  wallet: {
    select: {
      id: true,
      currency: true,
      chain: { select: { id: true, code: true, name: true } },
    },
  },
  requestedBy: { select: { id: true, email: true } },
  reviewedBy: { select: { id: true, email: true } },
  transferredBy: { select: { id: true, email: true } },
} satisfies Prisma.WithdrawalRequestSelect;

@Injectable()
export class PlatformFinanceService {
  constructor(private readonly prisma: PrismaService) {}

  getFinanceConfig() {
    return this.prisma.platformFinanceConfig.findUniqueOrThrow({
      where: { id: FINANCE_CONFIG_ID },
      include: { updatedBy: { select: { id: true, email: true } } },
    });
  }

  updateFinanceConfig(dto: UpdatePlatformFinanceConfigDto, adminUserId: string) {
    return this.prisma.platformFinanceConfig.upsert({
      where: { id: FINANCE_CONFIG_ID },
      create: {
        id: FINANCE_CONFIG_ID,
        paymentFeeRate: dto.paymentFeeRate,
        holdingPeriodDays: dto.holdingPeriodDays,
        minimumWithdrawalAmount: dto.minimumWithdrawalAmount,
        updatedById: adminUserId,
      },
      update: {
        paymentFeeRate: dto.paymentFeeRate,
        holdingPeriodDays: dto.holdingPeriodDays,
        minimumWithdrawalAmount: dto.minimumWithdrawalAmount,
        updatedById: adminUserId,
      },
      include: { updatedBy: { select: { id: true, email: true } } },
    });
  }

  async getBusinessWallet(businessId: string, query: PaginationQueryDto) {
    const wallet = await this.prisma.businessWallet.findUnique({
      where: { chainId: businessId },
      select: {
        id: true,
        currency: true,
        balance: true,
        heldBalance: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        chain: { select: { id: true, code: true, name: true, status: true } },
      },
    });
    if (!wallet) {
      throw new NotFoundException('Business wallet not found');
    }

    const where: Prisma.WalletLedgerEntryWhereInput = { walletId: wallet.id };
    const [entries, total] = await Promise.all([
      this.prisma.walletLedgerEntry.findMany({
        where,
        select: {
          id: true,
          type: true,
          amount: true,
          balanceAfter: true,
          referenceType: true,
          referenceId: true,
          description: true,
          createdAt: true,
          branch: { select: { id: true, code: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.walletLedgerEntry.count({ where }),
    ]);

    return {
      ...wallet,
      availableBalance: wallet.balance.minus(wallet.heldBalance),
      ledger: this.paginate(entries, total, query.page, query.limit),
    };
  }

  async createWithdrawalRequest(dto: CreateWithdrawalRequestDto, user: AuthenticatedUser) {
    if (!user.ownerId) {
      throw new BadRequestException('OWNER profile is required');
    }
    const ownerId = user.ownerId;
    const amount = new Prisma.Decimal(dto.amount);

    return this.prisma.$transaction(
      async (transaction) => {
        const wallet = await transaction.businessWallet.findFirst({
          where: {
            chainId: dto.businessId,
            status: WalletStatus.ACTIVE,
            chain: {
              deletedAt: null,
              status: RestaurantChainStatus.ACTIVE,
              ownerAssignments: { some: { ownerId } },
              subscription: {
                status: BusinessSubscriptionStatus.ACTIVE,
                expiresAt: { gt: new Date() },
              },
            },
          },
        });
        const config = await transaction.platformFinanceConfig.findUnique({
          where: { id: FINANCE_CONFIG_ID },
        });
        if (!wallet) {
          throw new NotFoundException('Active wallet for an assigned business not found');
        }
        if (!config) {
          throw new ConflictException('Platform finance configuration is missing');
        }
        if (amount.lessThan(config.minimumWithdrawalAmount)) {
          throw new BadRequestException(
            `Minimum withdrawal amount is ${config.minimumWithdrawalAmount.toString()}`,
          );
        }
        if (amount.greaterThan(wallet.balance.minus(wallet.heldBalance))) {
          throw new ConflictException('Insufficient available wallet balance');
        }

        await transaction.businessWallet.update({
          where: { id: wallet.id },
          data: { heldBalance: { increment: amount } },
        });
        return await transaction.withdrawalRequest.create({
          data: {
            walletId: wallet.id,
            requestedById: user.id,
            amount,
            bankName: dto.bankName.trim(),
            bankAccountName: dto.bankAccountName.trim(),
            bankAccountNumber: dto.bankAccountNumber.trim(),
          },
          select: withdrawalSelect,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async listOwnerWithdrawals(query: ListWithdrawalRequestsQueryDto, user: AuthenticatedUser) {
    if (!user.ownerId) {
      throw new BadRequestException('OWNER profile is required');
    }
    const where: Prisma.WithdrawalRequestWhereInput = {
      status: query.status,
      wallet: { chain: { ownerAssignments: { some: { ownerId: user.ownerId } } } },
    };
    return this.listWithdrawalsWithWhere(where, query);
  }

  listWithdrawalRequests(query: ListWithdrawalRequestsQueryDto) {
    const search = query.search?.trim();
    const where: Prisma.WithdrawalRequestWhereInput = {
      status: query.status,
      ...(search
        ? {
            OR: [
              {
                wallet: {
                  chain: { name: { contains: search, mode: Prisma.QueryMode.insensitive } },
                },
              },
              { bankAccountName: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { bankAccountNumber: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { bankTransactionCode: { contains: search, mode: Prisma.QueryMode.insensitive } },
            ],
          }
        : {}),
    };
    return this.listWithdrawalsWithWhere(where, query);
  }

  async getWithdrawalRequest(id: string) {
    const withdrawal = await this.prisma.withdrawalRequest.findUnique({
      where: { id },
      select: withdrawalSelect,
    });
    if (!withdrawal) {
      throw new NotFoundException('Withdrawal request not found');
    }
    return withdrawal;
  }

  approveWithdrawalRequest(id: string, adminUserId: string) {
    return this.transitionPendingWithdrawal(id, {
      status: WithdrawalRequestStatus.APPROVED,
      reviewedById: adminUserId,
      reviewedAt: new Date(),
      rejectionReason: null,
    });
  }

  async rejectWithdrawalRequest(id: string, reason: string, adminUserId: string) {
    await this.releaseHeldWithdrawal(id, WithdrawalRequestStatus.PENDING, {
      status: WithdrawalRequestStatus.REJECTED,
      rejectionReason: reason.trim(),
      reviewedById: adminUserId,
      reviewedAt: new Date(),
    });
    return this.getWithdrawalRequest(id);
  }

  async confirmWithdrawalTransfer(
    id: string,
    dto: ConfirmWithdrawalTransferDto,
    adminUserId: string,
  ) {
    await this.prisma.$transaction(
      async (transaction) => {
        const withdrawal = await transaction.withdrawalRequest.findFirst({
          where: { id, status: WithdrawalRequestStatus.APPROVED },
          include: { wallet: true },
        });
        if (!withdrawal) {
          const exists = await transaction.withdrawalRequest.count({ where: { id } });
          if (exists === 0) {
            throw new NotFoundException('Withdrawal request not found');
          }
          throw new ConflictException('Only an approved withdrawal can be transferred');
        }
        if (
          withdrawal.wallet.heldBalance.lessThan(withdrawal.amount) ||
          withdrawal.wallet.balance.lessThan(withdrawal.amount)
        ) {
          throw new ConflictException('Wallet balances are inconsistent with the withdrawal hold');
        }
        const balanceAfter = withdrawal.wallet.balance.minus(withdrawal.amount);
        await transaction.businessWallet.update({
          where: { id: withdrawal.walletId },
          data: {
            balance: { decrement: withdrawal.amount },
            heldBalance: { decrement: withdrawal.amount },
          },
        });
        await transaction.walletLedgerEntry.create({
          data: {
            walletId: withdrawal.walletId,
            type: WalletLedgerEntryType.WITHDRAWAL,
            amount: withdrawal.amount.negated(),
            balanceAfter,
            referenceType: 'WITHDRAWAL_REQUEST',
            referenceId: withdrawal.id,
            description: 'Owner withdrawal transferred by platform administrator',
          },
        });
        await transaction.withdrawalRequest.update({
          where: { id },
          data: {
            status: WithdrawalRequestStatus.TRANSFERRED,
            bankTransactionCode: dto.bankTransactionCode.trim(),
            transferredById: adminUserId,
            transferredAt: new Date(),
            transferFailureReason: null,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return this.getWithdrawalRequest(id);
  }

  async markWithdrawalTransferFailed(id: string, reason: string, adminUserId: string) {
    await this.releaseHeldWithdrawal(id, WithdrawalRequestStatus.APPROVED, {
      status: WithdrawalRequestStatus.TRANSFER_FAILED,
      transferFailureReason: reason.trim(),
      transferredById: adminUserId,
      transferredAt: new Date(),
    });
    return this.getWithdrawalRequest(id);
  }

  private async listWithdrawalsWithWhere(
    where: Prisma.WithdrawalRequestWhereInput,
    query: PaginationQueryDto,
  ) {
    const [items, total] = await Promise.all([
      this.prisma.withdrawalRequest.findMany({
        where,
        select: withdrawalSelect,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.withdrawalRequest.count({ where }),
    ]);
    return this.paginate(items, total, query.page, query.limit);
  }

  private async transitionPendingWithdrawal(
    id: string,
    data: Prisma.WithdrawalRequestUncheckedUpdateManyInput,
  ) {
    const result = await this.prisma.withdrawalRequest.updateMany({
      where: { id, status: WithdrawalRequestStatus.PENDING },
      data,
    });
    if (result.count === 0) {
      await this.throwWithdrawalTransitionError(id, 'Only a pending withdrawal can be reviewed');
    }
    return this.getWithdrawalRequest(id);
  }

  private async releaseHeldWithdrawal(
    id: string,
    expectedStatus: WithdrawalRequestStatus,
    data: Prisma.WithdrawalRequestUncheckedUpdateInput,
  ) {
    await this.prisma.$transaction(
      async (transaction) => {
        const withdrawal = await transaction.withdrawalRequest.findFirst({
          where: { id, status: expectedStatus },
        });
        if (!withdrawal) {
          const exists = await transaction.withdrawalRequest.count({ where: { id } });
          if (exists === 0) {
            throw new NotFoundException('Withdrawal request not found');
          }
          throw new ConflictException(
            expectedStatus === WithdrawalRequestStatus.PENDING
              ? 'Only a pending withdrawal can be rejected'
              : 'Only an approved withdrawal can be marked as failed',
          );
        }
        const wallet = await transaction.businessWallet.findUnique({
          where: { id: withdrawal.walletId },
        });
        if (!wallet || wallet.heldBalance.lessThan(withdrawal.amount)) {
          throw new ConflictException('Wallet held balance is inconsistent with the withdrawal');
        }
        await transaction.businessWallet.update({
          where: { id: withdrawal.walletId },
          data: { heldBalance: { decrement: withdrawal.amount } },
        });
        await transaction.withdrawalRequest.update({ where: { id }, data });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async throwWithdrawalTransitionError(
    id: string,
    conflictMessage: string,
  ): Promise<never> {
    const exists = await this.prisma.withdrawalRequest.count({ where: { id } });
    if (exists === 0) {
      throw new NotFoundException('Withdrawal request not found');
    }
    throw new ConflictException(conflictMessage);
  }

  private paginate<T>(items: T[], total: number, page: number, limit: number) {
    return { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }
}
