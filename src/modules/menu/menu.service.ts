import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BranchStatus, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import type {
  CreateMenuCategoryDto,
  CreateMenuItemDto,
  CreateMenuOptionDto,
  CreateMenuOptionGroupDto,
  ListMenuItemsQueryDto,
  SetMenuItemActiveDto,
  SetMenuItemBranchesDto,
  SetMenuItemOptionGroupsDto,
  UpdateBranchMenuItemDto,
  UpdateMenuCategoryDto,
  UpdateMenuItemDto,
  UpdateMenuOptionDto,
  UpdateMenuOptionGroupDto,
} from './dto/menu.dto.js';

const categorySelect = {
  id: true,
  chainId: true,
  name: true,
  description: true,
  displayOrder: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MenuCategorySelect;

const itemSelect = {
  id: true,
  categoryId: true,
  sku: true,
  name: true,
  description: true,
  price: true,
  imageUrl: true,
  preparationMinutes: true,
  isActive: true,
  isAvailable: true,
  createdAt: true,
  updatedAt: true,
  category: { select: { id: true, name: true, chainId: true, isActive: true } },
} satisfies Prisma.MenuItemSelect;

const optionSelect = {
  id: true,
  groupId: true,
  code: true,
  name: true,
  priceDelta: true,
  displayOrder: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MenuOptionSelect;

const optionGroupSelect = {
  id: true,
  chainId: true,
  code: true,
  name: true,
  isRequired: true,
  minSelections: true,
  maxSelections: true,
  displayOrder: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  options: {
    select: optionSelect,
    orderBy: [{ displayOrder: 'asc' as const }, { name: 'asc' as const }],
  },
} satisfies Prisma.MenuOptionGroupSelect;

/**
 * The menu lives on the chain: one catalogue, one price. Which branch actually
 * sells a given item is the only per-branch decision, and it lives in BranchMenuItem.
 */
@Injectable()
export class MenuService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  // --- Categories -----------------------------------------------------------

  async listCategories(chainId: string, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    return this.prisma.menuCategory.findMany({
      where: { chainId, deletedAt: null },
      select: {
        ...categorySelect,
        _count: { select: { items: { where: { deletedAt: null } } } },
      },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createCategory(chainId: string, dto: CreateMenuCategoryDto, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    return this.withUniqueConflict('A category with this name already exists in the chain', () =>
      this.prisma.menuCategory.create({
        data: { ...dto, chainId },
        select: categorySelect,
      }),
    );
  }

  async updateCategory(
    chainId: string,
    categoryId: string,
    dto: UpdateMenuCategoryDto,
    user: AuthenticatedUser,
  ) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    await this.getCategoryOrFail(chainId, categoryId);
    return this.withUniqueConflict('A category with this name already exists in the chain', () =>
      this.prisma.menuCategory.update({
        where: { id: categoryId },
        data: dto,
        select: categorySelect,
      }),
    );
  }

  async deleteCategory(chainId: string, categoryId: string, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    await this.getCategoryOrFail(chainId, categoryId);

    const itemCount = await this.prisma.menuItem.count({
      where: { categoryId, deletedAt: null },
    });
    if (itemCount > 0) {
      throw new ConflictException(
        `Move or delete the ${itemCount} item(s) in this category before deleting it`,
      );
    }

    await this.prisma.menuCategory.update({
      where: { id: categoryId },
      data: { deletedAt: new Date(), isActive: false },
    });
    return { message: 'Menu category deleted successfully' };
  }

  // --- Option groups and options ------------------------------------------

  async listOptionGroups(chainId: string, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    return this.prisma.menuOptionGroup.findMany({
      where: { chainId },
      select: {
        ...optionGroupSelect,
        _count: { select: { menuItems: true } },
      },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createOptionGroup(chainId: string, dto: CreateMenuOptionGroupDto, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    const minSelections = dto.minSelections ?? (dto.isRequired ? 1 : 0);
    const isRequired = dto.isRequired ?? minSelections > 0;
    const maxSelections = dto.maxSelections ?? 1;
    this.assertOptionGroupRules(isRequired, minSelections, maxSelections);

    return this.withUniqueConflict(
      'An option group with this code already exists in the chain',
      () =>
        this.prisma.menuOptionGroup.create({
          data: { ...dto, chainId, isRequired, minSelections, maxSelections },
          select: optionGroupSelect,
        }),
    );
  }

  async updateOptionGroup(
    chainId: string,
    groupId: string,
    dto: UpdateMenuOptionGroupDto,
    user: AuthenticatedUser,
  ) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    const group = await this.getOptionGroupOrFail(chainId, groupId);
    let minSelections = dto.minSelections ?? group.minSelections;
    if (dto.isRequired === true && dto.minSelections === undefined && minSelections === 0) {
      minSelections = 1;
    }
    if (dto.isRequired === false && dto.minSelections === undefined) {
      minSelections = 0;
    }
    const isRequired =
      dto.isRequired ?? (dto.minSelections !== undefined ? minSelections > 0 : group.isRequired);
    const maxSelections = dto.maxSelections ?? group.maxSelections;
    this.assertOptionGroupRules(isRequired, minSelections, maxSelections);

    return this.withUniqueConflict(
      'An option group with this code already exists in the chain',
      () =>
        this.prisma.menuOptionGroup.update({
          where: { id: groupId },
          data: { ...dto, isRequired, minSelections, maxSelections },
          select: optionGroupSelect,
        }),
    );
  }

  async deleteOptionGroup(chainId: string, groupId: string, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    await this.getOptionGroupOrFail(chainId, groupId);
    await this.prisma.menuOptionGroup.delete({ where: { id: groupId } });
    return { message: 'Menu option group deleted successfully' };
  }

  async createOption(
    chainId: string,
    groupId: string,
    dto: CreateMenuOptionDto,
    user: AuthenticatedUser,
  ) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    await this.getOptionGroupOrFail(chainId, groupId);
    return this.withUniqueConflict('An option with this code already exists in the group', () =>
      this.prisma.menuOption.create({
        data: { ...dto, groupId },
        select: optionSelect,
      }),
    );
  }

  async updateOption(
    chainId: string,
    groupId: string,
    optionId: string,
    dto: UpdateMenuOptionDto,
    user: AuthenticatedUser,
  ) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    await this.getOptionOrFail(chainId, groupId, optionId);
    return this.withUniqueConflict('An option with this code already exists in the group', () =>
      this.prisma.menuOption.update({
        where: { id: optionId },
        data: dto,
        select: optionSelect,
      }),
    );
  }

  async deleteOption(chainId: string, groupId: string, optionId: string, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    await this.getOptionOrFail(chainId, groupId, optionId);
    await this.prisma.menuOption.delete({ where: { id: optionId } });
    return { message: 'Menu option deleted successfully' };
  }

  // --- Items ----------------------------------------------------------------

  async listItems(chainId: string, query: ListMenuItemsQueryDto, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    const search = query.search;

    const items = await this.prisma.menuItem.findMany({
      where: {
        deletedAt: null,
        isActive: query.isActive,
        categoryId: query.categoryId,
        category: { chainId, deletedAt: null },
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: Prisma.QueryMode.insensitive } },
                { sku: { contains: search, mode: Prisma.QueryMode.insensitive } },
              ],
            }
          : {}),
      },
      select: {
        ...itemSelect,
        branchAvailability: {
          where: { branch: { deletedAt: null } },
          select: {
            branchId: true,
            isEnabled: true,
            isAvailable: true,
            remainingPortions: true,
            branch: { select: { id: true, code: true, name: true, status: true } },
          },
        },
      },
      orderBy: [{ category: { displayOrder: 'asc' } }, { name: 'asc' }],
    });

    return items.map(({ branchAvailability, ...item }) => ({
      ...item,
      branches: branchAvailability,
      enabledBranchCount: branchAvailability.filter(({ isEnabled }) => isEnabled).length,
    }));
  }

  async createItem(chainId: string, dto: CreateMenuItemDto, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    const { categoryId, branchIds, ...itemData } = dto;
    await this.getCategoryOrFail(chainId, categoryId);

    // Omitting branchIds means "sell it everywhere", which is the common case.
    const targetBranchIds = branchIds
      ? await this.assertBranchesInChain(chainId, branchIds)
      : await this.getChainBranchIds(chainId);

    return this.withUniqueConflict('A menu item with this SKU already exists', () =>
      this.prisma.menuItem.create({
        data: {
          ...itemData,
          categoryId,
          branchAvailability: {
            create: targetBranchIds.map((branchId) => ({ branchId })),
          },
        },
        select: itemSelect,
      }),
    );
  }

  async updateItem(
    chainId: string,
    itemId: string,
    dto: UpdateMenuItemDto,
    user: AuthenticatedUser,
  ) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    await this.getItemOrFail(chainId, itemId);
    if (dto.categoryId) {
      await this.getCategoryOrFail(chainId, dto.categoryId);
    }

    return this.prisma.menuItem.update({
      where: { id: itemId },
      data: dto,
      select: itemSelect,
    });
  }

  /**
   * The chain-wide kill switch. Turning an item off here stops every branch from
   * selling it, whatever each branch has configured.
   */
  async setItemActive(
    chainId: string,
    itemId: string,
    dto: SetMenuItemActiveDto,
    user: AuthenticatedUser,
  ) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    await this.getItemOrFail(chainId, itemId);

    return this.prisma.menuItem.update({
      where: { id: itemId },
      data: { isActive: dto.isActive },
      select: itemSelect,
    });
  }

  async deleteItem(chainId: string, itemId: string, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    await this.getItemOrFail(chainId, itemId);

    // Order history keeps a foreign key to the item, so this is a soft delete.
    await this.prisma.$transaction(async (transaction) => {
      await transaction.menuItem.update({
        where: { id: itemId },
        data: { deletedAt: new Date(), isActive: false },
      });
      await transaction.branchMenuItem.updateMany({
        where: { menuItemId: itemId },
        data: { isEnabled: false, isAvailable: false },
      });
    });
    return { message: 'Menu item deleted successfully' };
  }

  async listItemBranches(chainId: string, itemId: string, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    const item = await this.getItemOrFail(chainId, itemId);
    const branches = await this.prisma.branch.findMany({
      where: { chainId, deletedAt: null },
      select: {
        id: true,
        code: true,
        name: true,
        city: true,
        status: true,
        branchMenuItems: {
          where: { menuItemId: itemId },
          select: { isEnabled: true, isAvailable: true, remainingPortions: true, updatedAt: true },
        },
      },
      orderBy: [{ city: 'asc' }, { name: 'asc' }],
    });

    return {
      item: { id: item.id, sku: item.sku, name: item.name, isActive: item.isActive },
      branches: branches.map(({ branchMenuItems, ...branch }) => ({
        ...branch,
        isEnabled: branchMenuItems[0]?.isEnabled ?? false,
        isAvailable: branchMenuItems[0]?.isAvailable ?? false,
        remainingPortions: branchMenuItems[0]?.remainingPortions ?? null,
        updatedAt: branchMenuItems[0]?.updatedAt ?? null,
      })),
    };
  }

  /** Replaces the set of branches that carry an item; branches left out are switched off. */
  async setItemBranches(
    chainId: string,
    itemId: string,
    dto: SetMenuItemBranchesDto,
    user: AuthenticatedUser,
  ) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    await this.getItemOrFail(chainId, itemId);
    const selectedIds = await this.assertBranchesInChain(chainId, dto.branchIds);

    await this.prisma.$transaction(async (transaction) => {
      await transaction.branchMenuItem.updateMany({
        where: { menuItemId: itemId, branchId: { notIn: selectedIds } },
        data: { isEnabled: false },
      });
      for (const branchId of selectedIds) {
        await transaction.branchMenuItem.upsert({
          where: { branchId_menuItemId: { branchId, menuItemId: itemId } },
          create: { branchId, menuItemId: itemId, isEnabled: true },
          update: { isEnabled: true },
        });
      }
    });

    return this.listItemBranches(chainId, itemId, user);
  }

  async listItemOptionGroups(chainId: string, itemId: string, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    await this.getItemOrFail(chainId, itemId);
    const links = await this.prisma.menuItemOptionGroup.findMany({
      where: { menuItemId: itemId, group: { chainId } },
      select: {
        displayOrder: true,
        group: { select: optionGroupSelect },
      },
      orderBy: { displayOrder: 'asc' },
    });
    return links.map(({ displayOrder, group }) => ({ ...group, displayOrder }));
  }

  async setItemOptionGroups(
    chainId: string,
    itemId: string,
    dto: SetMenuItemOptionGroupsDto,
    user: AuthenticatedUser,
  ) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    await this.getItemOrFail(chainId, itemId);
    const selectedIds = await this.assertOptionGroupsInChain(chainId, dto.optionGroupIds);

    await this.prisma.$transaction(async (transaction) => {
      await transaction.menuItemOptionGroup.deleteMany({
        where: { menuItemId: itemId, groupId: { notIn: selectedIds } },
      });
      for (const [displayOrder, groupId] of selectedIds.entries()) {
        await transaction.menuItemOptionGroup.upsert({
          where: { menuItemId_groupId: { menuItemId: itemId, groupId } },
          create: { menuItemId: itemId, groupId, displayOrder },
          update: { displayOrder },
        });
      }
    });

    return this.listItemOptionGroups(chainId, itemId, user);
  }

  // --- Branch view ----------------------------------------------------------

  /** The menu as one branch actually sells it, after both switches are applied. */
  async getBranchMenu(branchId: string, user: AuthenticatedUser) {
    await this.branchAccess.assertCanAccessBranch(user, branchId);
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, deletedAt: null },
      select: { id: true, code: true, name: true, chainId: true, status: true },
    });
    if (!branch) {
      throw new NotFoundException('Branch not found');
    }

    const categories = await this.prisma.menuCategory.findMany({
      where: { chainId: branch.chainId, deletedAt: null, isActive: true },
      select: {
        ...categorySelect,
        items: {
          where: {
            deletedAt: null,
            isActive: true,
            branchAvailability: { some: { branchId, isEnabled: true } },
          },
          select: {
            id: true,
            sku: true,
            name: true,
            description: true,
            price: true,
            imageUrl: true,
            preparationMinutes: true,
            branchAvailability: {
              where: { branchId },
              select: { isAvailable: true, remainingPortions: true },
            },
          },
          orderBy: { name: 'asc' },
        },
      },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    });

    return {
      branch,
      categories: categories.map(({ items, ...category }) => ({
        ...category,
        items: items.map(({ branchAvailability, ...item }) => ({
          ...item,
          isAvailable: branchAvailability[0]?.isAvailable ?? false,
          remainingPortions: branchAvailability[0]?.remainingPortions ?? null,
        })),
      })),
    };
  }

  async updateBranchMenuItem(
    branchId: string,
    itemId: string,
    dto: UpdateBranchMenuItemDto,
    user: AuthenticatedUser,
  ) {
    await this.branchAccess.assertCanManageBranch(user, branchId);
    if (Object.keys(dto).length === 0) {
      throw new BadRequestException('Provide at least one field to update');
    }

    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, deletedAt: null },
      select: { chainId: true },
    });
    if (!branch) {
      throw new NotFoundException('Branch not found');
    }
    await this.getItemOrFail(branch.chainId, itemId);

    return this.prisma.branchMenuItem.upsert({
      where: { branchId_menuItemId: { branchId, menuItemId: itemId } },
      create: {
        branchId,
        menuItemId: itemId,
        isEnabled: dto.isEnabled ?? true,
        isAvailable: dto.isAvailable ?? true,
        remainingPortions: dto.remainingPortions ?? null,
        updatedById: user.employeeId,
      },
      update: { ...dto, updatedById: user.employeeId },
    });
  }

  // --- Helpers --------------------------------------------------------------

  private assertOptionGroupRules(
    isRequired: boolean,
    minSelections: number,
    maxSelections: number,
  ) {
    if (minSelections > maxSelections) {
      throw new BadRequestException('minSelections cannot exceed maxSelections');
    }
    if (isRequired !== minSelections > 0) {
      throw new BadRequestException(
        'isRequired must be true exactly when minSelections is greater than zero',
      );
    }
  }

  private async getOptionGroupOrFail(chainId: string, groupId: string) {
    const group = await this.prisma.menuOptionGroup.findFirst({
      where: { id: groupId, chainId },
      select: optionGroupSelect,
    });
    if (!group) {
      throw new NotFoundException('Menu option group not found in this chain');
    }
    return group;
  }

  private async getOptionOrFail(chainId: string, groupId: string, optionId: string) {
    const option = await this.prisma.menuOption.findFirst({
      where: { id: optionId, groupId, group: { chainId } },
      select: optionSelect,
    });
    if (!option) {
      throw new NotFoundException('Menu option not found in this chain and group');
    }
    return option;
  }

  private async assertOptionGroupsInChain(chainId: string, groupIds: string[]): Promise<string[]> {
    if (groupIds.length === 0) {
      return [];
    }
    const groups = await this.prisma.menuOptionGroup.findMany({
      where: { id: { in: groupIds }, chainId },
      select: { id: true },
    });
    if (groups.length !== groupIds.length) {
      const found = new Set(groups.map(({ id }) => id));
      const missing = groupIds.filter((id) => !found.has(id));
      throw new BadRequestException(
        `These option groups do not belong to this chain: ${missing.join(', ')}`,
      );
    }
    return groupIds;
  }

  private async getCategoryOrFail(chainId: string, categoryId: string) {
    const category = await this.prisma.menuCategory.findFirst({
      where: { id: categoryId, chainId, deletedAt: null },
      select: categorySelect,
    });
    if (!category) {
      throw new NotFoundException('Menu category not found in this chain');
    }
    return category;
  }

  private async getItemOrFail(chainId: string, itemId: string) {
    const item = await this.prisma.menuItem.findFirst({
      where: { id: itemId, deletedAt: null, category: { chainId, deletedAt: null } },
      select: itemSelect,
    });
    if (!item) {
      throw new NotFoundException('Menu item not found in this chain');
    }
    return item;
  }

  private async getChainBranchIds(chainId: string): Promise<string[]> {
    const branches = await this.prisma.branch.findMany({
      where: { chainId, deletedAt: null, status: { not: BranchStatus.INACTIVE } },
      select: { id: true },
    });
    return branches.map(({ id }) => id);
  }

  /** Rejects the whole request if any branch id belongs to another chain. */
  private async assertBranchesInChain(chainId: string, branchIds: string[]): Promise<string[]> {
    if (branchIds.length === 0) {
      return [];
    }
    const branches = await this.prisma.branch.findMany({
      where: { id: { in: branchIds }, chainId, deletedAt: null },
      select: { id: true },
    });
    if (branches.length !== branchIds.length) {
      const found = new Set(branches.map(({ id }) => id));
      const missing = branchIds.filter((id) => !found.has(id));
      throw new BadRequestException(
        `These branches do not belong to this chain: ${missing.join(', ')}`,
      );
    }
    return branches.map(({ id }) => id);
  }

  private async withUniqueConflict<T>(message: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(message);
      }
      throw error;
    }
  }
}
