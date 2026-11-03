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
import type { SaveComboDto, UpdateComboDto } from './combos.dto.js';
import type {
  AddCounterOrderItemDto,
  SelectedComboDto,
} from '../counter-operations/dto/counter-operations.dto.js';
const include = {
  components: { orderBy: { displayOrder: 'asc' as const }, include: { choices: true } },
};
export function validateCombo(components: SaveComboDto['components']) {
  if (!Array.isArray(components) || components.length < 2 || components.length > 6)
    throw new BadRequestException('A combo requires 2–6 components');
  for (const c of components) {
    if (!Number.isInteger(c.quantity) || c.quantity < 1 || c.quantity > 5 || !c.name?.trim())
      throw new BadRequestException('Invalid component quantity or name');
    const choices = c.choices ?? [];
    if (
      (c.type === 'FIXED' && choices.length !== 1) ||
      (c.type === 'CHOICE' && (choices.length < 2 || choices.length > 10)) ||
      !['FIXED', 'CHOICE'].includes(c.type)
    )
      throw new BadRequestException('FIXED requires one item; CHOICE requires 2–10 items');
    if (
      new Set(choices.map((x) => x.menuItemId)).size !== choices.length ||
      choices.filter((x) => x.isDefault).length !== 1
    )
      throw new BadRequestException('Choices must be unique with exactly one default');
    if (
      choices.some(
        (x) =>
          !Number.isFinite(Number(x.surcharge)) ||
          Number(x.surcharge) < 0 ||
          Number(x.surcharge) > 99999999999 ||
          Math.abs(Number(x.surcharge) * 100 - Math.round(Number(x.surcharge) * 100)) > 0.001,
      )
    )
      throw new BadRequestException('Invalid choice surcharge');
  }
}
@Injectable()
export class CombosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BranchAccessService,
    private readonly realtime: RealtimePublisher,
  ) {}
  async list(chainId: string, user: AuthenticatedUser) {
    await this.access.assertCanAccessChain(user, chainId);
    return this.prisma.combo.findMany({
      where: { chainId, deletedAt: null },
      include: { ...include, branches: true },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    });
  }
  async save(
    chainId: string,
    id: string | null,
    dto: SaveComboDto | UpdateComboDto,
    user: AuthenticatedUser,
  ) {
    await this.access.assertCanManageChain(user, chainId);
    const saved = await this.prisma.$transaction(async (tx) => {
      const old = id
        ? await tx.combo.findFirst({ where: { id, chainId, deletedAt: null }, include })
        : null;
      if (id && !old) throw new NotFoundException('Combo not found in this chain');
      const data = { ...old, ...dto };
      if (
        !data.name?.trim() ||
        !data.categoryId ||
        !Number.isFinite(Number(data.price)) ||
        Number(data.price) < 0 ||
        Number(data.price) > 99999999999
      )
        throw new BadRequestException('Valid combo name, category and price required');
      const components = (dto.components ??
        old?.components?.map((c) => ({
          ...c,
          choices: c.choices.map((x) => ({ ...x, surcharge: Number(x.surcharge) })),
        })))!;
      validateCombo(components);
      if (
        !(await tx.menuCategory.count({ where: { id: data.categoryId, chainId, deletedAt: null } }))
      )
        throw new BadRequestException('Category is outside this chain');
      const ids = [...new Set(components.flatMap((c) => c.choices.map((x) => x.menuItemId)))];
      const items = await tx.menuItem.findMany({
        where: { id: { in: ids }, deletedAt: null, category: { chainId } },
        include: { optionGroups: { include: { group: { include: { options: true } } } } },
      });
      if (items.length !== ids.length)
        throw new BadRequestException('Component items must belong to this chain');
      for (const component of components)
        if (component.fixedSizeCode)
          for (const choice of component.choices) {
            const item = items.find((i) => i.id === choice.menuItemId)!;
            if (
              !item.optionGroups.some(
                (l) =>
                  l.group.code.toUpperCase() === 'SIZE' &&
                  l.group.isActive &&
                  l.group.options.some((o) => o.code === component.fixedSizeCode && o.isActive),
              )
            )
              throw new BadRequestException('Fixed size must exist on every choice');
          }
      const fields = {
        categoryId: data.categoryId,
        name: data.name.trim(),
        price: data.price!,
        description: data.description,
        imageUrl: data.imageUrl,
        isActive: data.isActive ?? true,
        displayOrder: data.displayOrder ?? 0,
      };
      const result = id
        ? await tx.combo.update({ where: { id }, data: fields })
        : await tx.combo.create({ data: { chainId, ...fields } });
      if (!id || dto.components) {
        await tx.comboComponent.deleteMany({ where: { comboId: result.id } });
        for (const [index, c] of components.entries())
          await tx.comboComponent.create({
            data: {
              comboId: result.id,
              type: c.type,
              name: c.name.trim(),
              quantity: c.quantity,
              fixedSizeCode: c.fixedSizeCode,
              displayOrder: c.displayOrder ?? index,
              choices: {
                create: c.choices.map((x) => ({
                  menuItemId: x.menuItemId,
                  surcharge: x.surcharge,
                  isDefault: x.isDefault,
                })),
              },
            },
          });
      }
      if (!id) {
        const branches = await tx.branch.findMany({
          where: { chainId, deletedAt: null, status: 'ACTIVE' },
          select: { id: true },
        });
        if (branches.length)
          await tx.branchCombo.createMany({
            data: branches.map((b) => ({ branchId: b.id, comboId: result.id })),
          });
      }
      return tx.combo.findUniqueOrThrow({ where: { id: result.id }, include });
    });
    await this.emit(chainId, saved.id);
    return saved;
  }
  async remove(chainId: string, id: string, user: AuthenticatedUser) {
    await this.access.assertCanManageChain(user, chainId);
    const result = await this.prisma.combo.updateMany({
      where: { id, chainId, deletedAt: null },
      data: { deletedAt: new Date(), isActive: false },
    });
    if (!result.count) throw new NotFoundException('Combo not found');
    await this.emit(chainId, id);
    return { id, deleted: true };
  }
  async assign(chainId: string, id: string, branchIds: string[], user: AuthenticatedUser) {
    await this.access.assertCanManageChain(user, chainId);
    if (new Set(branchIds).size !== branchIds.length)
      throw new BadRequestException('Duplicate branch');
    await this.prisma.$transaction(async (tx) => {
      if (!(await tx.combo.count({ where: { id, chainId, deletedAt: null } })))
        throw new NotFoundException('Combo not found');
      if (
        (await tx.branch.count({ where: { id: { in: branchIds }, chainId, deletedAt: null } })) !==
        branchIds.length
      )
        throw new BadRequestException('Branch is outside this chain');
      await tx.branchCombo.updateMany({
        where: { comboId: id, branchId: { notIn: branchIds } },
        data: { isEnabled: false },
      });
      for (const branchId of branchIds)
        await tx.branchCombo.upsert({
          where: { branchId_comboId: { branchId, comboId: id } },
          create: { branchId, comboId: id },
          update: { isEnabled: true },
        });
    });
    await this.emit(chainId, id);
    return { id, branchIds };
  }
  async availability(user: AuthenticatedUser, id: string, isAvailable: boolean) {
    if (!['MANAGER', 'BARISTA'].includes(user.role) || !user.branchId)
      throw new ForbiddenException('Assigned Store Manager or Barista required');
    await this.access.assertSubscriptionAllowsWrite(user.branchId);
    const row = await this.prisma.branchCombo.findUnique({
      where: { branchId_comboId: { branchId: user.branchId, comboId: id } },
      include: { combo: true },
    });
    if (!row || !row.isEnabled || row.combo.deletedAt)
      throw new NotFoundException('Combo is not assigned to your branch');
    if (isAvailable && !row.combo.isActive)
      throw new ConflictException('Chain disabled this combo');
    const result = await this.prisma.branchCombo.update({
      where: { branchId_comboId: { branchId: user.branchId, comboId: id } },
      data: { isAvailable },
    });
    this.realtime.branch(user.branchId, 'menu.availability.changed', { comboId: id, isAvailable });
    return result;
  }
  async branchMenu(branchId: string) {
    const rows = await this.prisma.branchCombo.findMany({
      where: { branchId, isEnabled: true, combo: { deletedAt: null } },
      include: { combo: { include } },
    });
    const ids = [
      ...new Set(
        rows.flatMap((r) => r.combo.components.flatMap((c) => c.choices.map((x) => x.menuItemId))),
      ),
    ];
    const items = await this.prisma.menuItem.findMany({
      where: { id: { in: ids } },
      include: {
        branchAvailability: { where: { branchId } },
        optionGroups: {
          include: {
            group: {
              include: { options: { include: { branchAvailability: { where: { branchId } } } } },
            },
          },
        },
      },
    });
    return rows.map((row) => {
      const components = row.combo.components.map((c) => ({
        ...c,
        choices: c.choices.map((choice) => {
          const item = items.find((i) => i.id === choice.menuItemId)!,
            b = item.branchAvailability[0];
          const stockOk =
            !!b &&
            b.isEnabled &&
            b.isAvailable &&
            (b.remainingPortions === null || b.remainingPortions >= c.quantity);
          const sizeOk =
            !c.fixedSizeCode ||
            item.optionGroups.some(
              (l) =>
                l.group.code.toUpperCase() === 'SIZE' &&
                l.group.isActive &&
                l.group.options.some(
                  (o) =>
                    o.code === c.fixedSizeCode &&
                    o.isActive &&
                    !o.branchAvailability.some((a) => !a.isAvailable),
                ),
            );
          return {
            ...choice,
            menuItemId: item.id,
            itemName: item.name,
            menuItem: undefined,
            effectiveAvailable:
              item.isActive && item.isAvailable && !item.deletedAt && stockOk && sizeOk,
          };
        }),
      }));
      return {
        ...row,
        combo: {
          ...row.combo,
          components,
          chainPrice: row.combo.price,
          price: row.priceOverride ?? row.combo.price,
        },
        effectiveAvailable:
          row.combo.isActive &&
          row.isAvailable &&
          components.every((c) => c.choices.some((x) => x.effectiveAvailable)),
      };
    });
  }
  async price(
    tx: Prisma.TransactionClient,
    branchId: string,
    dto: SelectedComboDto,
    priceItem: (dto: AddCounterOrderItemDto) => Promise<{
      itemName: string;
      unitPrice: Prisma.Decimal;
      basePrice: Prisma.Decimal;
      selectedOptions: Prisma.InputJsonValue;
    }>,
  ) {
    const row = await tx.branchCombo.findUnique({
      where: { branchId_comboId: { branchId, comboId: dto.comboId } },
      include: { combo: { include } },
    });
    if (!row || !row.isEnabled || !row.isAvailable || !row.combo.isActive || row.combo.deletedAt)
      throw new ConflictException('Combo is unavailable at this branch');
    if (!Number.isInteger(dto.quantity) || dto.quantity < 1 || dto.quantity > 100)
      throw new BadRequestException('Invalid combo quantity');
    const selections = dto.components ?? [];
    if (
      new Set(selections.map((x) => x.componentId)).size !== selections.length ||
      selections.some((x) => !row.combo.components.some((c) => c.id === x.componentId))
    )
      throw new BadRequestException('Invalid or duplicate component');
    let unitPrice = new Prisma.Decimal(row.priceOverride ?? row.combo.price);
    const children = [];
    for (const c of row.combo.components) {
      const selection = selections.find((x) => x.componentId === c.id);
      const choice = selection?.menuItemId
        ? c.choices.find((x) => x.menuItemId === selection.menuItemId)
        : c.choices.find((x) => x.isDefault);
      if (!choice) throw new BadRequestException('Selected item is not a choice of this component');
      let optionIds = selection?.optionIds ?? [];
      if (c.fixedSizeCode) {
        const sizes = await tx.menuOption.findMany({
          where: {
            isActive: true,
            group: {
              isActive: true,
              code: 'SIZE',
              menuItems: { some: { menuItemId: choice.menuItemId } },
            },
          },
        });
        const fixed = sizes.find((x) => x.code === c.fixedSizeCode);
        if (!fixed || optionIds.some((id) => sizes.some((x) => x.id === id && x.id !== fixed.id)))
          throw new ConflictException('Component size is fixed or unavailable');
        optionIds = [...new Set([...optionIds, fixed.id])];
      }
      const priced = await priceItem({
        menuItemId: choice.menuItemId,
        quantity: c.quantity * dto.quantity,
        optionIds,
        extras: selection?.extras ?? [],
        specialInstructions: selection?.specialInstructions,
      });
      unitPrice = unitPrice.add(
        priced.unitPrice.sub(priced.basePrice).add(choice.surcharge).mul(c.quantity),
      );
      children.push({
        menuItemId: choice.menuItemId,
        itemName: priced.itemName,
        quantity: c.quantity * dto.quantity,
        specialInstructions: selection?.specialInstructions,
        selectedOptions: priced.selectedOptions,
        componentId: c.id,
        surcharge: choice.surcharge.toString(),
      });
    }
    if (unitPrice.lt(0) || unitPrice.gt('999999999999.99'))
      throw new BadRequestException('Invalid combo total');
    return {
      comboId: row.combo.id,
      itemName: row.combo.name,
      quantity: dto.quantity,
      unitPrice,
      children,
    };
  }
  private async emit(chainId: string, comboId: string) {
    const branches = await this.prisma.branch.findMany({
      where: { chainId, deletedAt: null },
      select: { id: true },
    });
    for (const b of branches) this.realtime.branch(b.id, 'menu.prices-updated', { comboId });
  }
}
