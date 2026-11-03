import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { RealtimePublisher } from '../../realtime/realtime.publisher.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import type { SaveExtraDto, SetItemExtrasDto } from './menu-extras.dto.js';
@Injectable()
export class MenuExtrasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BranchAccessService,
    private readonly realtime: RealtimePublisher,
  ) {}
  async list(chainId: string, user: AuthenticatedUser) {
    await this.access.assertCanAccessChain(user, chainId);
    return this.prisma.menuExtra.findMany({ where: { chainId }, orderBy: { name: 'asc' } });
  }
  async save(chainId: string, id: string | null, dto: SaveExtraDto, user: AuthenticatedUser) {
    await this.access.assertCanManageChain(user, chainId);
    if (!dto.name.trim()) throw new BadRequestException('Extra name is required');
    if (id && !(await this.prisma.menuExtra.findFirst({ where: { id, chainId } })))
      throw new NotFoundException('Extra not found in this chain');
    let result;
    try {
      result = id
        ? await this.prisma.menuExtra.update({
            where: { id },
            data: { ...dto, name: dto.name.trim() },
          })
        : await this.prisma.menuExtra.create({ data: { chainId, ...dto, name: dto.name.trim() } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ConflictException('An extra with this name already exists');
      throw error;
    }
    const branches = await this.prisma.branch.findMany({
      where: { chainId, deletedAt: null },
      select: { id: true },
    });
    for (const branch of branches)
      this.realtime.branch(branch.id, 'menu.prices-updated', { extraId: result.id });
    return result;
  }
  async itemExtras(chainId: string, menuItemId: string, user: AuthenticatedUser) {
    await this.access.assertCanAccessChain(user, chainId);
    const item = await this.prisma.menuItem.findFirst({
      where: { id: menuItemId, deletedAt: null, category: { chainId } },
      select: {
        id: true,
        maxExtras: true,
        extras: { orderBy: { displayOrder: 'asc' }, include: { extra: true } },
      },
    });
    if (!item) throw new NotFoundException('Item not found in this chain');
    return item;
  }

  async assign(
    chainId: string,
    menuItemId: string,
    dto: SetItemExtrasDto,
    user: AuthenticatedUser,
  ) {
    await this.access.assertCanManageChain(user, chainId);
    const result = await this.prisma.$transaction(async (tx) => {
      if (
        !(await tx.menuItem.findFirst({
          where: { id: menuItemId, deletedAt: null, category: { chainId } },
        }))
      )
        throw new NotFoundException('Item not found in this chain');
      const ids = dto.extras.map((x) => x.extraId);
      if (
        new Set(ids).size !== ids.length ||
        (await tx.menuExtra.count({ where: { id: { in: ids }, chainId } })) !== ids.length
      )
        throw new BadRequestException('Extras must be unique and in the same chain');
      await tx.menuItem.update({ where: { id: menuItemId }, data: { maxExtras: dto.maxExtras } });
      await tx.menuItemExtra.deleteMany({ where: { menuItemId } });
      if (ids.length)
        await tx.menuItemExtra.createMany({
          data: await Promise.all(
            dto.extras.map(async (x) => ({
              menuItemId,
              ...x,
              price:
                x.price ??
                (
                  await tx.menuExtra.findUniqueOrThrow({
                    where: { id: x.extraId },
                    select: { price: true },
                  })
                ).price,
            })),
          ),
        });
      return tx.menuItemExtra.findMany({ where: { menuItemId }, include: { extra: true } });
    });
    const branches = await this.prisma.branchMenuItem.findMany({
      where: { menuItemId },
      select: { branchId: true },
    });
    for (const branch of branches)
      this.realtime.branch(branch.branchId, 'menu.prices-updated', { menuItemId });
    return result;
  }
  async disable(chainId: string, id: string, user: AuthenticatedUser) {
    await this.access.assertCanManageChain(user, chainId);
    const extra = await this.prisma.menuExtra.findFirst({ where: { id, chainId } });
    if (!extra) throw new NotFoundException('Extra not found in this chain');
    return this.save(
      chainId,
      id,
      { name: extra.name, price: Number(extra.price), isActive: false },
      user,
    );
  }
  async availability(user: AuthenticatedUser, extraId: string, isAvailable: boolean) {
    if (!['MANAGER', 'BARISTA'].includes(user.role) || !user.branchId)
      throw new ForbiddenException('Assigned Store Manager or Barista required');
    const branchId = user.branchId;
    await this.access.assertCanAccessBranch(user, branchId);
    await this.access.assertSubscriptionAllowsWrite(branchId);
    const extra = await this.prisma.menuExtra.findFirst({
      where: { id: extraId, chain: { branches: { some: { id: branchId, deletedAt: null } } } },
    });
    if (!extra) throw new NotFoundException('Extra not found in your chain');
    if (isAvailable && !extra.isActive)
      throw new ConflictException('The chain disabled this extra');
    const result = await this.prisma.branchMenuExtra.upsert({
      where: { branchId_extraId: { branchId, extraId } },
      create: { branchId, extraId, isAvailable },
      update: { isAvailable },
    });
    this.realtime.branch(branchId, 'menu.availability.changed', { extraId, isAvailable });
    // Warn Store Manager if a paid order still requires this extra; do not cancel it automatically.
    if (!isAvailable) {
      const items = await this.prisma.orderItem.findMany({
        where: {
          order: {
            branchId,
            paymentStatus: 'PAID',
            status: { in: ['SUBMITTED', 'PREPARING', 'READY'] },
          },
          status: { not: 'CANCELLED' },
        },
        select: { orderId: true, selectedOptions: true },
      });
      const orderIds = [
        ...new Set(
          items
            .filter(
              (item) =>
                Array.isArray(item.selectedOptions) &&
                item.selectedOptions.some(
                  (option) =>
                    option &&
                    typeof option === 'object' &&
                    !Array.isArray(option) &&
                    option.id === extraId &&
                    option.kind === 'EXTRA',
                ),
            )
            .map((item) => item.orderId),
        ),
      ];
      if (orderIds.length) {
        await this.prisma.order.updateMany({
          where: {
            id: { in: orderIds },
            branchId,
            paymentStatus: 'PAID',
            status: { in: ['SUBMITTED', 'PREPARING', 'READY'] },
            attentionAt: null,
          },
          data: { attentionAt: new Date(), attentionReason: 'EXTRA_OUT_OF_STOCK' },
        });
        this.realtime.branch(branchId, 'manager.order.attention-required', {
          reason: 'EXTRA_OUT_OF_STOCK',
          extraId,
          orderIds,
        });
      }
    }
    return result;
  }
}
