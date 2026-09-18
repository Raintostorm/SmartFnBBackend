import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OrderItemStatus,
  OrderStatus,
  Prisma,
  ServingTaskStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import type { AddOrderItemDto, CreateOrderDto, PaginationDto } from './dto/order-operations.dto.js';
import { assertItemTransition, deriveOrderStatus } from './order-state-machine.js';

const orderInclude = {
  tableSession: { include: { tables: { where: { releasedAt: null }, include: { table: true } } } },
  items: { orderBy: { createdAt: 'asc' as const } },
};

@Injectable()
export class OrdersService {
  private readonly defaultPageSize: number;
  private readonly maxPageSize: number;
  private readonly maxItemsPerOrder: number;
  private readonly claimTimeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.defaultPageSize = config.get<number>('OPERATIONS_DEFAULT_PAGE_SIZE', 20);
    this.maxPageSize = config.get<number>('OPERATIONS_MAX_PAGE_SIZE', 100);
    this.maxItemsPerOrder = config.get<number>('OPERATIONS_MAX_ITEMS_PER_ORDER', 50);
    this.claimTimeoutMs = config.get<number>('SERVING_TASK_CLAIM_TIMEOUT_SECONDS', 300) * 1000;
  }

  private employee(user: AuthenticatedUser): { employeeId: string; branchId: string } {
    if (!user.employeeId || !user.branchId)
      throw new ForbiddenException('An assigned employee profile is required');
    return { employeeId: user.employeeId, branchId: user.branchId };
  }

  async createOrder(user: AuthenticatedUser, dto: CreateOrderDto) {
    const actor = this.employee(user);
    const session = await this.prisma.tableSession.findFirst({
      where: {
        id: dto.tableSessionId,
        branchId: actor.branchId,
        status: { in: ['OPEN', 'SERVING'] },
      },
      include: { tables: { where: { releasedAt: null }, take: 1 } },
    });
    if (!session) throw new NotFoundException('Open table session was not found in your branch');
    const code = `ORD-${Date.now()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    return this.prisma.order.create({
      data: {
        orderCode: code,
        branchId: actor.branchId,
        tableSessionId: session.id,
        tableId: session.tables[0]?.tableId,
        waiterId: actor.employeeId,
        createdByWaiterId: actor.employeeId,
        note: dto.note,
      },
      include: orderInclude,
    });
  }

  async getOrder(user: AuthenticatedUser, orderId: string) {
    const { branchId } = this.employee(user);
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId },
      include: orderInclude,
    });
    if (!order) throw new NotFoundException('Order was not found in your branch');
    return order;
  }

  async addItem(user: AuthenticatedUser, orderId: string, dto: AddOrderItemDto) {
    const actor = this.employee(user);
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, branchId: actor.branchId },
        include: { _count: { select: { items: true } } },
      });
      if (!order) throw new NotFoundException('Order was not found in your branch');
      if (order.status !== OrderStatus.PENDING)
        throw new ConflictException('Items can only be added before the order is submitted');
      if (order._count.items >= this.maxItemsPerOrder)
        throw new BadRequestException(
          `An order cannot contain more than ${this.maxItemsPerOrder} line items`,
        );
      const availability = await tx.branchMenuItem.findUnique({
        where: { branchId_menuItemId: { branchId: actor.branchId, menuItemId: dto.menuItemId } },
        include: { menuItem: true },
      });
      if (
        !availability?.isEnabled ||
        !availability.isAvailable ||
        !availability.menuItem.isActive ||
        !availability.menuItem.isAvailable
      )
        throw new ConflictException('Menu item is not currently available at this branch');
      if (availability.remainingPortions !== null && availability.remainingPortions < dto.quantity)
        throw new ConflictException('Not enough portions remain for this menu item');
      const totalPrice = availability.menuItem.price.mul(dto.quantity);
      const item = await tx.orderItem.create({
        data: {
          orderId,
          menuItemId: dto.menuItemId,
          itemName: availability.menuItem.name,
          unitPrice: availability.menuItem.price,
          quantity: dto.quantity,
          totalPrice,
          specialInstructions: dto.specialInstructions,
        },
      });
      await this.recalculateOrder(tx, orderId);
      return item;
    });
  }

  async submit(user: AuthenticatedUser, orderId: string) {
    const actor = this.employee(user);
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, branchId: actor.branchId },
        include: { items: true },
      });
      if (!order) throw new NotFoundException('Order was not found in your branch');
      if (order.status !== OrderStatus.PENDING)
        throw new ConflictException('Order has already been submitted');
      if (!order.items.length) throw new BadRequestException('Cannot submit an empty order');
      const now = new Date();
      for (const item of order.items) {
        const limitedStock = await tx.branchMenuItem.findFirst({
          where: {
            branchId: actor.branchId,
            menuItemId: item.menuItemId,
            remainingPortions: { not: null },
          },
          select: { remainingPortions: true },
        });
        if (limitedStock) {
          const reserved = await tx.branchMenuItem.updateMany({
            where: {
              branchId: actor.branchId,
              menuItemId: item.menuItemId,
              isEnabled: true,
              isAvailable: true,
              remainingPortions: { gte: item.quantity },
            },
            data: { remainingPortions: { decrement: item.quantity } },
          });
          if (!reserved.count)
            throw new ConflictException(`${item.itemName} no longer has enough portions`);
        }
      }
      await tx.orderItem.updateMany({
        where: { orderId, status: OrderItemStatus.PENDING },
        data: { status: OrderItemStatus.QUEUED, queuedAt: now },
      });
      return tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.SUBMITTED, submittedAt: now },
        include: orderInclude,
      });
    });
  }

  async kitchenQueue(user: AuthenticatedUser, query: PaginationDto) {
    const { branchId } = this.employee(user);
    const { page, pageSize } = this.page(query);
    const where = {
      order: { branchId },
      status: { in: [OrderItemStatus.QUEUED, OrderItemStatus.PREPARING] },
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.orderItem.findMany({
        where,
        include: {
          order: { select: { orderCode: true, tableId: true, placedAt: true } },
          menuItem: { select: { preparationMinutes: true } },
          startedByKitchen: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: [{ queuedAt: 'asc' }, { createdAt: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.orderItem.count({ where }),
    ]);
    return { data: items, meta: { page, pageSize, total, pageCount: Math.ceil(total / pageSize) } };
  }

  startItem(user: AuthenticatedUser, itemId: string) {
    return this.transitionKitchenItem(
      user,
      itemId,
      OrderItemStatus.QUEUED,
      OrderItemStatus.PREPARING,
    );
  }
  readyItem(user: AuthenticatedUser, itemId: string) {
    return this.transitionKitchenItem(
      user,
      itemId,
      OrderItemStatus.PREPARING,
      OrderItemStatus.READY,
    );
  }

  async unavailableItem(user: AuthenticatedUser, itemId: string, reason: string) {
    const actor = this.employee(user);
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.orderItem.findFirst({
        where: { id: itemId, order: { branchId: actor.branchId } },
      });
      if (!item) throw new NotFoundException('Order item was not found in your branch');
      if (item.status !== OrderItemStatus.QUEUED && item.status !== OrderItemStatus.PREPARING)
        throw new ConflictException('Only queued or preparing items can be marked unavailable');
      const result = await tx.orderItem.updateMany({
        where: { id: itemId, status: item.status },
        data: {
          status: OrderItemStatus.OUT_OF_STOCK,
          unavailableAt: new Date(),
          unavailableById: actor.employeeId,
          cancellationReason: reason,
        },
      });
      if (result.count !== 1)
        throw new ConflictException('Order item was updated by another employee');
      await this.syncOrderStatus(tx, item.orderId);
      return tx.orderItem.findUniqueOrThrow({ where: { id: itemId } });
    });
  }

  async servingQueue(user: AuthenticatedUser, query: PaginationDto) {
    const actor = this.employee(user);
    const { page, pageSize } = this.page(query);
    const expired = new Date(Date.now() - this.claimTimeoutMs);
    const where = {
      branchId: actor.branchId,
      OR: [
        { status: ServingTaskStatus.WAITING },
        {
          status: ServingTaskStatus.CLAIMED,
          OR: [{ claimedByWaiterId: actor.employeeId }, { claimedAt: { lt: expired } }],
        },
      ],
    };
    const [tasks, total] = await this.prisma.$transaction([
      this.prisma.servingTask.findMany({
        where,
        include: {
          orderItem: { include: { order: { select: { orderCode: true, tableId: true } } } },
          claimedByWaiter: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { availableAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.servingTask.count({ where }),
    ]);
    return { data: tasks, meta: { page, pageSize, total, pageCount: Math.ceil(total / pageSize) } };
  }

  async claimTask(user: AuthenticatedUser, taskId: string) {
    const actor = this.employee(user);
    const expired = new Date(Date.now() - this.claimTimeoutMs);
    const now = new Date();
    const result = await this.prisma.servingTask.updateMany({
      where: {
        id: taskId,
        branchId: actor.branchId,
        OR: [
          { status: ServingTaskStatus.WAITING },
          { status: ServingTaskStatus.CLAIMED, claimedAt: { lt: expired } },
        ],
      },
      data: {
        status: ServingTaskStatus.CLAIMED,
        claimedByWaiterId: actor.employeeId,
        claimedAt: now,
      },
    });
    if (!result.count)
      throw new ConflictException('Serving task is unavailable or already claimed');
    return this.prisma.servingTask.findUniqueOrThrow({ where: { id: taskId } });
  }

  async serveTask(user: AuthenticatedUser, taskId: string) {
    const actor = this.employee(user);
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.servingTask.findFirst({
        where: { id: taskId, branchId: actor.branchId },
        include: { orderItem: true },
      });
      if (!task) throw new NotFoundException('Serving task was not found in your branch');
      if (task.status !== ServingTaskStatus.CLAIMED || task.claimedByWaiterId !== actor.employeeId)
        throw new ConflictException('Serving task must be claimed by the current waiter');
      assertItemTransition(task.orderItem.status, OrderItemStatus.SERVED);
      const now = new Date();
      await tx.orderItem.update({
        where: { id: task.orderItemId },
        data: { status: OrderItemStatus.SERVED, servedAt: now, servedByWaiterId: actor.employeeId },
      });
      await tx.servingTask.update({
        where: { id: taskId },
        data: {
          status: ServingTaskStatus.SERVED,
          servedAt: now,
          servedByWaiterId: actor.employeeId,
        },
      });
      await this.syncOrderStatus(tx, task.orderItem.orderId);
      return tx.servingTask.findUniqueOrThrow({
        where: { id: taskId },
        include: { orderItem: true },
      });
    });
  }

  private async transitionKitchenItem(
    user: AuthenticatedUser,
    itemId: string,
    from: OrderItemStatus,
    to: OrderItemStatus,
  ) {
    const actor = this.employee(user);
    assertItemTransition(from, to);
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.orderItem.findFirst({
        where: { id: itemId, order: { branchId: actor.branchId } },
      });
      if (!item) throw new NotFoundException('Order item was not found in your branch');
      if (item.status !== from)
        throw new ConflictException(`Order item must be ${from} before becoming ${to}`);
      const data =
        to === OrderItemStatus.PREPARING
          ? { status: to, startedAt: now, startedByKitchenId: actor.employeeId }
          : { status: to, completedAt: now, readyAt: now, completedByKitchenId: actor.employeeId };
      const result = await tx.orderItem.updateMany({ where: { id: itemId, status: from }, data });
      if (!result.count)
        throw new ConflictException('Order item was updated by another kitchen employee');
      if (to === OrderItemStatus.READY)
        await tx.servingTask.create({ data: { orderItemId: itemId, branchId: actor.branchId } });
      await this.syncOrderStatus(tx, item.orderId);
      return tx.orderItem.findUniqueOrThrow({
        where: { id: itemId },
        include: { servingTask: true },
      });
    });
  }

  private page(query: PaginationDto) {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? this.defaultPageSize, this.maxPageSize);
    return { page, pageSize };
  }
  private async recalculateOrder(tx: Prisma.TransactionClient, orderId: string) {
    const sums = await tx.orderItem.aggregate({
      where: { orderId, status: { not: OrderItemStatus.CANCELLED } },
      _sum: { totalPrice: true },
    });
    const subtotal = sums._sum.totalPrice ?? 0;
    await tx.order.update({ where: { id: orderId }, data: { subtotal, totalAmount: subtotal } });
  }
  private async syncOrderStatus(tx: Prisma.TransactionClient, orderId: string) {
    const items = await tx.orderItem.findMany({ where: { orderId }, select: { status: true } });
    const status = deriveOrderStatus(items.map((item: { status: OrderItemStatus }) => item.status));
    await tx.order.update({
      where: { id: orderId },
      data: { status, completedAt: status === OrderStatus.SERVED ? new Date() : undefined },
    });
  }
}
