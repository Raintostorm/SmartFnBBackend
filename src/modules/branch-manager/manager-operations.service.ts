import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import type { ManagerAuditQueryDto, ManagerOrderQueryDto } from './manager.dto.js';
import { managerActor, writeBranchAudit } from './manager-scope.js';

const actorSelect = { id: true, employeeCode: true, firstName: true, lastName: true };
const paymentSelect = {
  id: true,
  paymentCode: true,
  method: true,
  provider: true,
  status: true,
  amount: true,
  receivedAmount: true,
  transactionRef: true,
  confirmationReason: true,
  confirmedAt: true,
  paidAt: true,
  createdAt: true,
  failureReason: true,
  processedBy: { select: actorSelect },
} satisfies Prisma.PaymentSelect;
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
  createdByCashier: { select: actorSelect },
  createdByWaiter: { select: actorSelect },
  payments: { select: paymentSelect },
  tableSession: { select: { id: true, sessionCode: true, payments: { select: paymentSelect } } },
} satisfies Prisma.OrderSelect;

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
    if (query.from && query.to && new Date(query.from) >= new Date(query.to))
      throw new BadRequestException('from must be earlier than to');
    const search = query.search?.trim();
    const number = search && /^\d+$/.test(search) ? Number(search) : undefined;
    const where: Prisma.OrderWhereInput = {
      branchId,
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
      AND: [
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
        select: summarySelect,
        orderBy: [{ placedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.order.count({ where }),
    ]);
    return { items, total, page: query.page, limit: query.limit };
  }

  async order(user: AuthenticatedUser, id: string) {
    const { branchId } = await this.scope(user);
    const order = await this.prisma.order.findFirst({
      where: { id, branchId },
      select: {
        ...summarySelect,
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
            cancellationReason: true,
            cancelledAt: true,
            cancelledBy: { select: actorSelect },
            startedAt: true,
            completedAt: true,
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found in your branch');
    const paymentIds = [...order.payments, ...(order.tableSession?.payments ?? [])].map(
      (p) => p.id,
    );
    const audit = await this.prisma.branchAuditLog.findMany({
      where: { branchId, entityId: { in: [id, ...paymentIds] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return { ...order, audit };
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
              unavailableAt: new Date(),
              unavailableById: employeeId,
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
}
