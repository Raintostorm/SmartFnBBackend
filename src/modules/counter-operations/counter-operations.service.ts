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
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
  PrintDocumentType,
  Prisma,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import type {
  AddCounterOrderItemDto,
  AvailabilityDto,
  CashPaymentDto,
  CheckoutCounterOrderDto,
  CreateCounterOrderDto,
} from './dto/counter-operations.dto.js';

const counterOrderInclude = {
  items: {
    include: { units: { orderBy: { sequence: 'asc' as const } } },
    orderBy: { createdAt: 'asc' as const },
  },
  payments: { orderBy: { createdAt: 'desc' as const } },
} satisfies Prisma.OrderInclude;

@Injectable()
export class CounterOperationsService {
  constructor(private readonly prisma: PrismaService) {}

  private employee(user: AuthenticatedUser) {
    if (!user.employeeId || !user.branchId) {
      throw new ForbiddenException('An assigned employee profile is required');
    }
    return { employeeId: user.employeeId, branchId: user.branchId };
  }

  async cashierContext(user: AuthenticatedUser) {
    const actor = this.employee(user);
    const [branch, menuItems] = await this.prisma.$transaction([
      this.prisma.branch.findUniqueOrThrow({
        where: { id: actor.branchId },
        select: {
          id: true,
          chainId: true,
          name: true,
          timezone: true,
          chain: { select: { currency: true } },
        },
      }),
      this.prisma.branchMenuItem.findMany({
        where: {
          branchId: actor.branchId,
          isEnabled: true,
          menuItem: { isActive: true, deletedAt: null },
        },
        include: {
          menuItem: {
            include: {
              category: true,
              optionGroups: {
                orderBy: { displayOrder: 'asc' },
                include: {
                  group: {
                    include: {
                      options: {
                        where: { isActive: true },
                        orderBy: { displayOrder: 'asc' },
                        include: {
                          branchAvailability: { where: { branchId: actor.branchId }, take: 1 },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: [
          { menuItem: { category: { displayOrder: 'asc' } } },
          { menuItem: { name: 'asc' } },
        ],
      }),
    ]);
    return { branch, menuItems };
  }

  createDraft(user: AuthenticatedUser, dto: CreateCounterOrderDto) {
    const actor = this.employee(user);
    return this.prisma.order.create({
      data: {
        orderCode: `CTR-${Date.now()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
        branchId: actor.branchId,
        createdByCashierId: actor.employeeId,
        type: OrderType.COUNTER_PICKUP,
        note: dto.note,
      },
      include: counterOrderInclude,
    });
  }

  async checkout(user: AuthenticatedUser, dto: CheckoutCounterOrderDto) {
    const actor = this.employee(user);
    if (!dto.items.length) throw new BadRequestException('Cannot checkout an empty cart');

    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          orderCode: `CTR-${Date.now()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
          branchId: actor.branchId,
          createdByCashierId: actor.employeeId,
          type: OrderType.COUNTER_PICKUP,
          status: OrderStatus.CONFIRMED,
          note: dto.note,
        },
      });

      let total = new Prisma.Decimal(0);
      for (const cartItem of dto.items) {
        const priced = await this.priceCartItem(tx, actor.branchId, cartItem);
        const lineTotal = priced.unitPrice.mul(cartItem.quantity);
        total = total.add(lineTotal);
        await tx.orderItem.create({
          data: {
            orderId: order.id,
            menuItemId: cartItem.menuItemId,
            itemName: priced.itemName,
            unitPrice: priced.unitPrice,
            quantity: cartItem.quantity,
            totalPrice: lineTotal,
            specialInstructions: cartItem.specialInstructions,
            selectedOptions: priced.selectedOptions,
          },
        });
      }

      return tx.order.update({
        where: { id: order.id },
        data: { subtotal: total, totalAmount: total },
        include: counterOrderInclude,
      });
    });
  }

  async getOrder(user: AuthenticatedUser, orderId: string) {
    const actor = this.employee(user);
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId: actor.branchId, type: OrderType.COUNTER_PICKUP },
      include: counterOrderInclude,
    });
    if (!order) throw new NotFoundException('Counter order was not found in your branch');
    return order;
  }

  async addItem(user: AuthenticatedUser, orderId: string, dto: AddCounterOrderItemDto) {
    const actor = this.employee(user);
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, branchId: actor.branchId, type: OrderType.COUNTER_PICKUP },
      });
      if (!order) throw new NotFoundException('Counter order was not found in your branch');
      if (order.status !== OrderStatus.PENDING) {
        throw new ConflictException('A finalized or paid order cannot be edited');
      }

      const availability = await tx.branchMenuItem.findUnique({
        where: { branchId_menuItemId: { branchId: actor.branchId, menuItemId: dto.menuItemId } },
        include: {
          menuItem: {
            include: {
              optionGroups: { include: { group: { include: { options: true } } } },
            },
          },
        },
      });
      if (
        !availability?.isEnabled ||
        !availability.isAvailable ||
        !availability.menuItem.isActive ||
        !availability.menuItem.isAvailable
      ) {
        throw new ConflictException('Menu item is not currently available at this branch');
      }
      if (
        availability.remainingPortions !== null &&
        availability.remainingPortions < dto.quantity
      ) {
        throw new ConflictException('Not enough portions remain for this menu item');
      }

      const allowedOptions = availability.menuItem.optionGroups.flatMap((link) =>
        link.group.options.map((option) => ({ ...option, group: link.group })),
      );
      const selected = dto.optionIds.map((id) => allowedOptions.find((option) => option.id === id));
      if (selected.some((option) => !option)) {
        throw new BadRequestException('One or more options do not belong to this menu item');
      }
      const selectedOptions = selected as (typeof allowedOptions)[number][];
      const unavailableCount = await tx.branchMenuOption.count({
        where: {
          branchId: actor.branchId,
          optionId: { in: dto.optionIds },
          isAvailable: false,
        },
      });
      if (unavailableCount)
        throw new ConflictException('One or more selected options are sold out');

      for (const link of availability.menuItem.optionGroups) {
        const count = selectedOptions.filter((option) => option.groupId === link.groupId).length;
        if (count < link.group.minSelections || count > link.group.maxSelections) {
          throw new BadRequestException(
            `${link.group.name} requires between ${link.group.minSelections} and ${link.group.maxSelections} selections`,
          );
        }
      }

      const optionDelta = selectedOptions.reduce(
        (sum, option) => sum.add(option.priceDelta),
        new Prisma.Decimal(0),
      );
      const unitPrice = availability.menuItem.price.add(optionDelta);
      const item = await tx.orderItem.create({
        data: {
          orderId,
          menuItemId: dto.menuItemId,
          itemName: availability.menuItem.name,
          unitPrice,
          quantity: dto.quantity,
          totalPrice: unitPrice.mul(dto.quantity),
          specialInstructions: dto.specialInstructions,
          selectedOptions: selectedOptions.map((option) => ({
            id: option.id,
            groupId: option.groupId,
            groupName: option.group.name,
            name: option.name,
            priceDelta: option.priceDelta.toString(),
          })),
        },
      });
      await this.recalculateOrder(tx, orderId);
      return item;
    });
  }

  async removeItem(user: AuthenticatedUser, orderId: string, itemId: string) {
    const actor = this.employee(user);
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.orderItem.findFirst({
        where: {
          id: itemId,
          orderId,
          order: {
            branchId: actor.branchId,
            type: OrderType.COUNTER_PICKUP,
            status: OrderStatus.PENDING,
          },
        },
      });
      if (!item) throw new NotFoundException('Editable order item was not found');
      await tx.orderItem.delete({ where: { id: itemId } });
      await this.recalculateOrder(tx, orderId);
      return { deleted: true };
    });
  }

  async finalize(user: AuthenticatedUser, orderId: string) {
    const actor = this.employee(user);
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId: actor.branchId, type: OrderType.COUNTER_PICKUP },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Counter order was not found in your branch');
    if (order.status !== OrderStatus.PENDING)
      throw new ConflictException('Order is already finalized');
    if (!order.items.length) throw new BadRequestException('Cannot finalize an empty order');
    return this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.CONFIRMED },
      include: counterOrderInclude,
    });
  }

  async collectCash(user: AuthenticatedUser, orderId: string, dto: CashPaymentDto) {
    const actor = this.employee(user);
    return this.prisma.$transaction(
      async (tx) => {
        const order = await tx.order.findFirst({
          where: { id: orderId, branchId: actor.branchId, type: OrderType.COUNTER_PICKUP },
          include: { items: true },
        });
        if (!order) throw new NotFoundException('Counter order was not found in your branch');
        if (
          order.status !== OrderStatus.CONFIRMED ||
          order.paymentStatus !== OrderPaymentStatus.UNPAID
        ) {
          throw new ConflictException('Order is not awaiting payment');
        }
        const station = await tx.posStation.findFirst({
          where: { id: dto.stationId, branchId: actor.branchId, status: 'ACTIVE' },
          select: { id: true },
        });
        if (!station) throw new NotFoundException('Active POS station was not found in your branch');
        const tendered = new Prisma.Decimal(dto.tenderedAmount);
        if (tendered.lt(order.totalAmount))
          throw new BadRequestException('Tendered cash is insufficient');

        const quantities = new Map<string, number>();
        for (const item of order.items) {
          quantities.set(item.menuItemId, (quantities.get(item.menuItemId) ?? 0) + item.quantity);
        }
        for (const [menuItemId, quantity] of quantities) {
          const availability = await tx.branchMenuItem.findUnique({
            where: { branchId_menuItemId: { branchId: actor.branchId, menuItemId } },
            select: { isEnabled: true, isAvailable: true, remainingPortions: true },
          });
          if (!availability?.isEnabled || !availability.isAvailable) {
            throw new ConflictException('A menu item is no longer available');
          }
          if (availability.remainingPortions !== null) {
            const reserved = await tx.branchMenuItem.updateMany({
              where: {
                branchId: actor.branchId,
                menuItemId,
                isEnabled: true,
                isAvailable: true,
                remainingPortions: { gte: quantity },
              },
              data: { remainingPortions: { decrement: quantity } },
            });
            if (!reserved.count) throw new ConflictException('Not enough portions remain for a menu item');
          }
        }

        const branch = await tx.branch.findUniqueOrThrow({
          where: { id: actor.branchId },
          select: { timezone: true },
        });
        const businessDate = this.businessDate(branch.timezone);
        const sequence = await tx.branchDailySequence.upsert({
          where: { branchId_businessDate: { branchId: actor.branchId, businessDate } },
          create: { branchId: actor.branchId, businessDate, nextNumber: 1 },
          update: { nextNumber: { increment: 1 } },
        });
        const now = new Date();
        const payment = await tx.payment.create({
          data: {
            paymentCode: `PAY-${Date.now()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
            orderId,
            processedById: actor.employeeId,
            method: PaymentMethod.CASH,
            provider: PaymentProvider.CASH,
            status: PaymentStatus.SUCCESS,
            amount: order.totalAmount,
            tenderedAmount: tendered,
            changeAmount: tendered.sub(order.totalAmount),
            paidAt: now,
            confirmedAt: now,
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
          where: { id: orderId },
          data: {
            status: OrderStatus.SUBMITTED,
            paymentStatus: OrderPaymentStatus.PAID,
            paidAt: now,
            submittedAt: now,
            businessDate,
            callNumber: sequence.nextNumber,
          },
          include: counterOrderInclude,
        });
        const printJobs = await Promise.all(
          [PrintDocumentType.RECEIPT, PrintDocumentType.QUEUE_TICKET].map((type) =>
            tx.printJob.create({
              data: {
                orderId,
                branchId: actor.branchId,
                stationId: station.id,
                type,
                printedById: actor.employeeId,
              },
            }),
          ),
        );
        return { order: updatedOrder, payment, printJobs };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async cashierHistory(user: AuthenticatedUser) {
    const actor = this.employee(user);
    const branch = await this.prisma.branch.findUniqueOrThrow({
      where: { id: actor.branchId },
      select: { timezone: true },
    });
    return this.prisma.order.findMany({
      where: {
        branchId: actor.branchId,
        type: OrderType.COUNTER_PICKUP,
        businessDate: this.businessDate(branch.timezone),
      },
      include: counterOrderInclude,
      orderBy: { createdAt: 'desc' },
    });
  }

  async cancelUnpaid(user: AuthenticatedUser, orderId: string, reason: string) {
    const actor = this.employee(user);
    if (reason.trim().length < 3) throw new BadRequestException('A cancellation reason is required');
    const changed = await this.prisma.order.updateMany({
      where: {
        id: orderId,
        branchId: actor.branchId,
        type: OrderType.COUNTER_PICKUP,
        status: OrderStatus.CONFIRMED,
        paymentStatus: OrderPaymentStatus.UNPAID,
      },
      data: {
        status: OrderStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelledById: actor.employeeId,
        cancellationReason: reason.trim(),
      },
    });
    if (!changed.count) throw new ConflictException('Only an unpaid counter order can be cancelled');
    return { cancelled: true };
  }

  async receipt(user: AuthenticatedUser, orderId: string) {
    const actor = this.employee(user);
    const order = await this.prisma.order.findFirst({
      where: {
        id: orderId,
        branchId: actor.branchId,
        type: OrderType.COUNTER_PICKUP,
        paymentStatus: OrderPaymentStatus.PAID,
      },
      include: {
        items: { orderBy: { createdAt: 'asc' } },
        payments: { where: { status: PaymentStatus.SUCCESS }, orderBy: { paidAt: 'desc' }, take: 1 },
        branch: {
          include: { chain: { include: { branding: true } } },
        },
        createdByCashier: { select: { firstName: true, lastName: true, employeeCode: true } },
      },
    });
    if (!order) throw new NotFoundException('Paid counter order was not found in your branch');
    const branding = order.branch.chain.branding;
    return {
      orderId: order.id,
      orderCode: order.orderCode,
      callNumber: order.callNumber,
      paidAt: order.paidAt,
      currency: order.branch.chain.currency,
      seller: {
        name: branding?.displayName ?? order.branch.chain.name,
        logoUrl: branding?.logoUrl ?? order.branch.chain.logoUrl,
        branchName: order.branch.name,
        address: [order.branch.addressLine1, order.branch.addressLine2, order.branch.ward, order.branch.district, order.branch.city].filter(Boolean).join(', '),
        phone: order.branch.phone,
      },
      cashier: order.createdByCashier
        ? `${order.createdByCashier.firstName} ${order.createdByCashier.lastName}`.trim()
        : null,
      items: order.items,
      subtotal: order.subtotal,
      totalAmount: order.totalAmount,
      payment: order.payments[0] ?? null,
    };
  }

  async reprint(user: AuthenticatedUser, orderId: string, reason: string) {
    const actor = this.employee(user);
    if (reason.trim().length < 3) throw new BadRequestException('A reprint reason is required');
    const receipt = await this.receipt(user, orderId);
    await this.prisma.printJob.createMany({
      data: [PrintDocumentType.RECEIPT, PrintDocumentType.QUEUE_TICKET].map((type) => ({
        orderId,
        branchId: actor.branchId,
        type,
        printedById: actor.employeeId,
        isReprint: true,
        reason: reason.trim(),
      })),
    });
    return receipt;
  }

  async baristaQueue(user: AuthenticatedUser) {
    const actor = this.employee(user);
    const units = await this.prisma.orderItemUnit.findMany({
      where: {
        status: { in: [OrderItemStatus.QUEUED, OrderItemStatus.PREPARING] },
        orderItem: {
          order: {
            branchId: actor.branchId,
            type: OrderType.COUNTER_PICKUP,
            paymentStatus: OrderPaymentStatus.PAID,
          },
        },
      },
      include: { orderItem: { include: { order: true, menuItem: { select: { categoryId: true } } } } },
      orderBy: [{ orderItem: { order: { paidAt: 'asc' } } }, { sequence: 'asc' }],
    });

    const windowMs = 5 * 60_000;
    const maxBatchSize = 4;
    const pending = units.filter((unit) => unit.status === OrderItemStatus.QUEUED);
    const batches: Array<{
      id: string;
      menuItemId: string;
      itemName: string;
      categoryId: string;
      size: string;
      oldestPaidAt: Date;
      status: 'QUEUED' | 'PREPARING';
      units: Array<{
        id: string;
        sequence: number;
        callNumber: number | null;
        options: Prisma.JsonValue;
        specialInstructions: string | null;
      }>;
    }> = [];

    while (pending.length) {
      const head = pending.shift()!;
      const headOptions = this.optionSnapshots(head.orderItem.selectedOptions);
      const headSize = this.sizeOption(headOptions);
      const headTime = head.orderItem.order.paidAt ?? head.createdAt;
      const selected = [head];
      for (let index = 0; index < pending.length && selected.length < maxBatchSize; ) {
        const candidate = pending[index];
        const candidateOptions = this.optionSnapshots(candidate.orderItem.selectedOptions);
        const candidateSize = this.sizeOption(candidateOptions);
        const candidateTime = candidate.orderItem.order.paidAt ?? candidate.createdAt;
        if (
          candidate.orderItem.menuItemId === head.orderItem.menuItemId &&
          candidateSize === headSize &&
          candidateTime.getTime() - headTime.getTime() <= windowMs
        ) {
          selected.push(candidate);
          pending.splice(index, 1);
        } else index += 1;
      }
      batches.push({
        id: selected.map((unit) => unit.id).join(':'),
        menuItemId: head.orderItem.menuItemId,
        itemName: head.orderItem.itemName,
        categoryId: head.orderItem.menuItem.categoryId,
        size: headSize,
        oldestPaidAt: headTime,
        status: 'QUEUED',
        units: selected.map((unit) => ({
          id: unit.id,
          sequence: unit.sequence,
          callNumber: unit.orderItem.order.callNumber,
          options: unit.orderItem.selectedOptions ?? [],
          specialInstructions: unit.orderItem.specialInstructions,
        })),
      });
    }
    const preparingGroups = new Map<string, typeof units>();
    for (const unit of units.filter((candidate) => candidate.status === OrderItemStatus.PREPARING)) {
      const options = this.optionSnapshots(unit.orderItem.selectedOptions);
      const key = `${unit.startedById}:${unit.startedAt?.toISOString()}:${unit.orderItem.menuItemId}:${this.sizeOption(options)}`;
      const group = preparingGroups.get(key) ?? [];
      group.push(unit);
      preparingGroups.set(key, group);
    }
    for (const group of preparingGroups.values()) {
      const head = group[0];
      const options = this.optionSnapshots(head.orderItem.selectedOptions);
      batches.unshift({
        id: group.map((unit) => unit.id).join(':'),
        menuItemId: head.orderItem.menuItemId,
        itemName: head.orderItem.itemName,
        categoryId: head.orderItem.menuItem.categoryId,
        size: this.sizeOption(options),
        oldestPaidAt: head.orderItem.order.paidAt ?? head.createdAt,
        status: 'PREPARING',
        units: group.map((unit) => ({
          id: unit.id,
          sequence: unit.sequence,
          callNumber: unit.orderItem.order.callNumber,
          options: unit.orderItem.selectedOptions ?? [],
          specialInstructions: unit.orderItem.specialInstructions,
        })),
      });
    }
    return batches;
  }

  async baristaReadyOrders(user: AuthenticatedUser) {
    const actor = this.employee(user);
    return this.prisma.order.findMany({
      where: {
        branchId: actor.branchId,
        type: OrderType.COUNTER_PICKUP,
        paymentStatus: OrderPaymentStatus.PAID,
        status: OrderStatus.READY,
      },
      select: {
        id: true,
        orderCode: true,
        callNumber: true,
        readyAt: true,
        items: { select: { id: true, itemName: true, quantity: true } },
      },
      orderBy: { readyAt: 'asc' },
    });
  }

  async startBatch(user: AuthenticatedUser, unitIds: string[]) {
    const actor = this.employee(user);
    if (!unitIds.length || unitIds.length > 4)
      throw new BadRequestException('A preparation batch must contain between 1 and 4 units');
    return this.prisma.$transaction(async (tx) => {
      const units = await tx.orderItemUnit.findMany({
        where: {
          id: { in: unitIds },
          orderItem: { order: { branchId: actor.branchId, type: OrderType.COUNTER_PICKUP } },
        },
        include: { orderItem: true },
      });
      if (units.length !== unitIds.length) throw new NotFoundException('One or more units were not found');
      const now = new Date();
      const changed = await tx.orderItemUnit.updateMany({
        where: { id: { in: unitIds }, status: OrderItemStatus.QUEUED },
        data: { status: OrderItemStatus.PREPARING, startedAt: now, startedById: actor.employeeId },
      });
      if (changed.count !== unitIds.length)
        throw new ConflictException('This batch was already claimed by another barista');
      for (const itemId of new Set(units.map((unit) => unit.orderItemId))) {
        await this.syncCounterStatus(tx, units.find((unit) => unit.orderItemId === itemId)!.orderItem.orderId, itemId);
      }
      return { unitIds, startedAt: now, startedById: actor.employeeId };
    });
  }

  startUnit(user: AuthenticatedUser, unitId: string) {
    return this.transitionUnit(user, unitId, OrderItemStatus.QUEUED, OrderItemStatus.PREPARING);
  }

  completeUnit(user: AuthenticatedUser, unitId: string) {
    return this.transitionUnit(user, unitId, OrderItemStatus.PREPARING, OrderItemStatus.READY);
  }

  async deliverOrder(user: AuthenticatedUser, orderId: string) {
    const actor = this.employee(user);
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, branchId: actor.branchId, type: OrderType.COUNTER_PICKUP },
        include: { items: { include: { units: true } } },
      });
      if (!order) throw new NotFoundException('Counter order was not found in your branch');
      if (order.status !== OrderStatus.READY)
        throw new ConflictException('Only a ready order can be delivered');
      const now = new Date();
      await tx.orderItemUnit.updateMany({
        where: { orderItem: { orderId }, status: OrderItemStatus.READY },
        data: { status: OrderItemStatus.DELIVERED },
      });
      await tx.orderItem.updateMany({
        where: { orderId, status: OrderItemStatus.READY },
        data: { status: OrderItemStatus.DELIVERED, servedAt: now },
      });
      return tx.order.update({
        where: { id: orderId },
        data: {
          status: OrderStatus.DELIVERED,
          deliveredAt: now,
          completedAt: now,
          deliveredById: actor.employeeId,
        },
        include: counterOrderInclude,
      });
    });
  }

  async setMenuItemAvailability(user: AuthenticatedUser, menuItemId: string, dto: AvailabilityDto) {
    const actor = this.employee(user);
    const result = await this.prisma.branchMenuItem.updateMany({
      where: { branchId: actor.branchId, menuItemId },
      data: { isAvailable: dto.isAvailable, updatedById: actor.employeeId },
    });
    if (!result.count) throw new NotFoundException('Menu item is not configured for your branch');
    return { menuItemId, isAvailable: dto.isAvailable };
  }

  async setOptionAvailability(user: AuthenticatedUser, optionId: string, dto: AvailabilityDto) {
    const actor = this.employee(user);
    const option = await this.prisma.menuOption.findFirst({
      where: { id: optionId, group: { chain: { branches: { some: { id: actor.branchId } } } } },
      select: { id: true },
    });
    if (!option) throw new NotFoundException('Menu option was not found for your branch');
    return this.prisma.branchMenuOption.upsert({
      where: { branchId_optionId: { branchId: actor.branchId, optionId } },
      create: {
        branchId: actor.branchId,
        optionId,
        isAvailable: dto.isAvailable,
        updatedById: actor.employeeId,
      },
      update: { isAvailable: dto.isAvailable, updatedById: actor.employeeId },
    });
  }

  private async transitionUnit(
    user: AuthenticatedUser,
    unitId: string,
    from: OrderItemStatus,
    to: OrderItemStatus,
  ) {
    const actor = this.employee(user);
    return this.prisma.$transaction(async (tx) => {
      const unit = await tx.orderItemUnit.findFirst({
        where: {
          id: unitId,
          orderItem: { order: { branchId: actor.branchId, type: OrderType.COUNTER_PICKUP } },
        },
        include: { orderItem: true },
      });
      if (!unit) throw new NotFoundException('Preparation unit was not found in your branch');
      if (unit.status !== from) throw new ConflictException(`Preparation unit must be ${from}`);
      const now = new Date();
      const changed = await tx.orderItemUnit.updateMany({
        where: { id: unitId, status: from },
        data:
          to === OrderItemStatus.PREPARING
            ? { status: to, startedAt: now, startedById: actor.employeeId }
            : { status: to, completedAt: now, completedById: actor.employeeId },
      });
      if (!changed.count) throw new ConflictException('Preparation unit was updated concurrently');
      await this.syncCounterStatus(tx, unit.orderItem.orderId, unit.orderItemId);
      return tx.orderItemUnit.findUniqueOrThrow({ where: { id: unitId } });
    });
  }

  private async syncCounterStatus(tx: Prisma.TransactionClient, orderId: string, itemId: string) {
    const itemUnits = await tx.orderItemUnit.findMany({
      where: { orderItemId: itemId },
      select: { status: true },
    });
    const itemStatus = itemUnits.every((unit) => unit.status === OrderItemStatus.READY)
      ? OrderItemStatus.READY
      : itemUnits.some(
            (unit) =>
              unit.status === OrderItemStatus.PREPARING || unit.status === OrderItemStatus.READY,
          )
        ? OrderItemStatus.PREPARING
        : OrderItemStatus.QUEUED;
    await tx.orderItem.update({
      where: { id: itemId },
      data:
        itemStatus === OrderItemStatus.READY
          ? { status: itemStatus, readyAt: new Date(), completedAt: new Date() }
          : { status: itemStatus },
    });
    const items = await tx.orderItem.findMany({ where: { orderId }, select: { status: true } });
    const orderStatus = items.every((item) => item.status === OrderItemStatus.READY)
      ? OrderStatus.READY
      : items.some(
            (item) =>
              item.status === OrderItemStatus.PREPARING || item.status === OrderItemStatus.READY,
          )
        ? OrderStatus.PREPARING
        : OrderStatus.SUBMITTED;
    await tx.order.update({
      where: { id: orderId },
      data:
        orderStatus === OrderStatus.READY
          ? { status: orderStatus, readyAt: new Date() }
          : { status: orderStatus },
    });
  }

  private async recalculateOrder(tx: Prisma.TransactionClient, orderId: string) {
    const result = await tx.orderItem.aggregate({
      where: { orderId, status: { not: OrderItemStatus.CANCELLED } },
      _sum: { totalPrice: true },
    });
    const subtotal = result._sum.totalPrice ?? new Prisma.Decimal(0);
    await tx.order.update({ where: { id: orderId }, data: { subtotal, totalAmount: subtotal } });
  }

  private async priceCartItem(
    tx: Prisma.TransactionClient,
    branchId: string,
    dto: AddCounterOrderItemDto,
  ) {
    const availability = await tx.branchMenuItem.findUnique({
      where: { branchId_menuItemId: { branchId, menuItemId: dto.menuItemId } },
      include: {
        menuItem: {
          include: { optionGroups: { include: { group: { include: { options: true } } } } },
        },
      },
    });
    if (!availability?.isEnabled || !availability.isAvailable || !availability.menuItem.isActive || !availability.menuItem.isAvailable)
      throw new ConflictException('Menu item is not currently available at this branch');
    if (availability.remainingPortions !== null && availability.remainingPortions < dto.quantity)
      throw new ConflictException('Not enough portions remain for this menu item');

    const allowed = availability.menuItem.optionGroups.flatMap((link) =>
      link.group.options.filter((option) => option.isActive).map((option) => ({ ...option, group: link.group })),
    );
    const selected = dto.optionIds.map((id) => allowed.find((option) => option.id === id));
    if (selected.some((option) => !option))
      throw new BadRequestException('One or more options do not belong to this menu item');
    const options = selected as (typeof allowed)[number][];
    const unavailable = await tx.branchMenuOption.count({
      where: { branchId, optionId: { in: dto.optionIds }, isAvailable: false },
    });
    if (unavailable) throw new ConflictException('One or more selected options are sold out');
    for (const link of availability.menuItem.optionGroups) {
      const count = options.filter((option) => option.groupId === link.groupId).length;
      if (count < link.group.minSelections || count > link.group.maxSelections)
        throw new BadRequestException(`${link.group.name} requires between ${link.group.minSelections} and ${link.group.maxSelections} selections`);
    }
    const optionDelta = options.reduce((sum, option) => sum.add(option.priceDelta), new Prisma.Decimal(0));
    return {
      itemName: availability.menuItem.name,
      unitPrice: availability.menuItem.price.add(optionDelta),
      selectedOptions: options.map((option) => ({
        id: option.id,
        code: option.code,
        groupId: option.groupId,
        groupCode: option.group.code,
        groupName: option.group.name,
        name: option.name,
        priceDelta: option.priceDelta.toString(),
      })),
    };
  }

  private optionSnapshots(value: Prisma.JsonValue | null) {
    if (!Array.isArray(value)) return [];
    return value.filter((option): option is Record<string, Prisma.JsonValue> => !!option && typeof option === 'object' && !Array.isArray(option));
  }

  private sizeOption(options: Record<string, Prisma.JsonValue>[]) {
    const size = options.find((option) =>
      String(option.groupCode ?? option.groupName ?? '').toLowerCase().includes('size'),
    );
    return size ? String(size.name ?? '') : '';
  }

  private businessDate(timezone: string) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return new Date(`${value.year}-${value.month}-${value.day}T00:00:00.000Z`);
  }
}
