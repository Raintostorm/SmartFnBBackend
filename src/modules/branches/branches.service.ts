import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BranchAreaStatus,
  BranchAreaType,
  BranchStatus,
  BusinessSubscriptionStatus,
  Prisma,
  RestaurantChainStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AppRole } from '../auth/app-role.enum.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import type { CreateBranchAreaDto, UpdateBranchAreaDto } from './dto/branch-area.dto.js';
import type {
  CreateBranchDto,
  ListBranchesQueryDto,
  ListPublicBranchesQueryDto,
  UpdateBranchDto,
} from './dto/branch.dto.js';
import type { UpsertBranchHourDto, UpsertBranchSpecialHourDto } from './dto/branch-hours.dto.js';
import type {
  CreateRestaurantChainDto,
  UpdateRestaurantChainDto,
} from './dto/restaurant-chain.dto.js';
import { BranchAccessService } from './branch-access.service.js';

const chainSummarySelect = {
  id: true,
  code: true,
  name: true,
  logoUrl: true,
  email: true,
  phone: true,
  website: true,
  taxCode: true,
  headquartersAddress: true,
  timezone: true,
  currency: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.RestaurantChainSelect;

const branchSummarySelect = {
  id: true,
  chainId: true,
  code: true,
  name: true,
  phone: true,
  email: true,
  addressLine1: true,
  addressLine2: true,
  ward: true,
  district: true,
  city: true,
  country: true,
  timezone: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  chain: {
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
    },
  },
} satisfies Prisma.BranchSelect;

@Injectable()
export class BranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  async createChain(dto: CreateRestaurantChainDto) {
    return this.withUniqueConflict('Restaurant chain code already exists', () =>
      this.prisma.restaurantChain.create({
        data: dto,
        select: chainSummarySelect,
      }),
    );
  }

  listChains() {
    return this.prisma.restaurantChain.findMany({
      where: { deletedAt: null },
      select: {
        ...chainSummarySelect,
        _count: {
          select: {
            branches: { where: { deletedAt: null } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getChain(id: string) {
    const chain = await this.prisma.restaurantChain.findFirst({
      where: { id, deletedAt: null },
      select: {
        ...chainSummarySelect,
        branches: {
          where: { deletedAt: null },
          select: branchSummarySelect,
          orderBy: { name: 'asc' },
        },
      },
    });

    if (!chain) {
      throw new NotFoundException('Restaurant chain not found');
    }

    return chain;
  }

  async updateChain(id: string, dto: UpdateRestaurantChainDto) {
    await this.ensureChainExists(id);
    return this.withUniqueConflict('Restaurant chain code already exists', () =>
      this.prisma.restaurantChain.update({
        where: { id },
        data: dto,
        select: chainSummarySelect,
      }),
    );
  }

  async updateChainStatus(id: string, status: RestaurantChainStatus) {
    await this.ensureChainExists(id);
    return this.prisma.restaurantChain.update({
      where: { id },
      data: { status },
      select: chainSummarySelect,
    });
  }

  async createBranch(chainId: string, dto: CreateBranchDto, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    await this.ensureChainExists(chainId);
    const subscription = await this.prisma.businessSubscription.findFirst({
      where: {
        chainId,
        status: BusinessSubscriptionStatus.ACTIVE,
        expiresAt: { gt: new Date() },
      },
      select: { plan: { select: { maxBranches: true } } },
    });
    if (!subscription) {
      throw new ForbiddenException('The business subscription is not active');
    }
    const branchCount = await this.prisma.branch.count({ where: { chainId, deletedAt: null } });
    if (branchCount >= subscription.plan.maxBranches) {
      throw new ConflictException('Service plan branch limit has been reached');
    }
    return this.withUniqueConflict('Branch code already exists', () =>
      this.prisma.branch.create({
        data: { ...dto, chainId },
        select: branchSummarySelect,
      }),
    );
  }

  async listBranches(user: AuthenticatedUser, query: ListBranchesQueryDto) {
    const accessibleBranchIds = await this.branchAccess.getAccessibleBranchIds(user);
    const canUseFilters = user.role === AppRole.OWNER;
    return this.prisma.branch.findMany({
      where: {
        deletedAt: null,
        ...(accessibleBranchIds === null ? {} : { id: { in: accessibleBranchIds } }),
        ...(canUseFilters
          ? {
              chainId: query.chainId,
              status: query.status,
              city: query.city
                ? { equals: query.city, mode: Prisma.QueryMode.insensitive }
                : undefined,
            }
          : {}),
      },
      select: branchSummarySelect,
      orderBy: [{ city: 'asc' }, { name: 'asc' }],
    });
  }

  async getBranch(id: string, user: AuthenticatedUser) {
    await this.branchAccess.assertCanAccessBranch(user, id);
    const branch = await this.prisma.branch.findFirst({
      where: { id, deletedAt: null },
      select: {
        ...branchSummarySelect,
        operatingHours: { orderBy: { dayOfWeek: 'asc' } },
        specialHours: { orderBy: { date: 'asc' } },
        areas: {
          where: {
            deletedAt: null,
            type: { in: this.getVisibleAreaTypes(user.role) },
          },
          orderBy: [{ floor: 'asc' }, { name: 'asc' }],
        },
      },
    });

    if (!branch) {
      throw new NotFoundException('Branch not found');
    }

    return branch;
  }

  async updateBranch(id: string, dto: UpdateBranchDto, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageBranch(user, id);
    await this.ensureBranchExists(id);
    return this.withUniqueConflict('Branch code already exists', () =>
      this.prisma.branch.update({
        where: { id },
        data: dto,
        select: branchSummarySelect,
      }),
    );
  }

  async updateBranchStatus(id: string, status: BranchStatus, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageBranch(user, id);
    const branch = await this.prisma.branch.findFirst({
      where: { id, deletedAt: null },
      select: { status: true },
    });
    if (!branch) {
      throw new NotFoundException('Branch not found');
    }
    if (
      user.role === AppRole.MANAGER &&
      (status === BranchStatus.INACTIVE || branch.status === BranchStatus.INACTIVE)
    ) {
      throw new ForbiddenException('Only OWNER can deactivate or reactivate a branch');
    }
    return this.prisma.branch.update({
      where: { id },
      data: { status },
      select: branchSummarySelect,
    });
  }

  async listOperatingHours(branchId: string, user: AuthenticatedUser) {
    await this.branchAccess.assertCanAccessBranch(user, branchId);
    await this.ensureBranchExists(branchId);
    return this.prisma.branchOperatingHour.findMany({
      where: { branchId },
      orderBy: { dayOfWeek: 'asc' },
    });
  }

  async upsertOperatingHour(
    branchId: string,
    dayOfWeek: number,
    dto: UpsertBranchHourDto,
    user: AuthenticatedUser,
  ) {
    await this.branchAccess.assertCanManageBranch(user, branchId);
    await this.ensureBranchExists(branchId);
    this.assertDayOfWeek(dayOfWeek);
    const hours = this.normalizeHours(dto);

    return this.prisma.branchOperatingHour.upsert({
      where: { branchId_dayOfWeek: { branchId, dayOfWeek } },
      create: { branchId, dayOfWeek, ...hours },
      update: hours,
    });
  }

  async listSpecialHours(branchId: string, user: AuthenticatedUser) {
    await this.branchAccess.assertCanAccessBranch(user, branchId);
    await this.ensureBranchExists(branchId);
    return this.prisma.branchSpecialHour.findMany({
      where: { branchId },
      orderBy: { date: 'asc' },
    });
  }

  async upsertSpecialHour(
    branchId: string,
    dateValue: string,
    dto: UpsertBranchSpecialHourDto,
    user: AuthenticatedUser,
  ) {
    await this.branchAccess.assertCanManageBranch(user, branchId);
    await this.ensureBranchExists(branchId);
    const date = this.parseDate(dateValue);
    const hours = this.normalizeHours(dto);

    return this.prisma.branchSpecialHour.upsert({
      where: { branchId_date: { branchId, date } },
      create: { branchId, date, note: dto.note, ...hours },
      update: { note: dto.note, ...hours },
    });
  }

  async deleteSpecialHour(branchId: string, dateValue: string, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageBranch(user, branchId);
    await this.ensureBranchExists(branchId);
    const date = this.parseDate(dateValue);
    const specialHour = await this.prisma.branchSpecialHour.findUnique({
      where: { branchId_date: { branchId, date } },
      select: { id: true },
    });

    if (!specialHour) {
      throw new NotFoundException('Special operating hour not found');
    }

    await this.prisma.branchSpecialHour.delete({ where: { id: specialHour.id } });
    return { message: 'Special operating hour deleted successfully' };
  }

  async listAreas(branchId: string, user: AuthenticatedUser) {
    await this.branchAccess.assertCanAccessBranch(user, branchId);
    await this.ensureBranchExists(branchId);
    return this.prisma.branchArea.findMany({
      where: {
        branchId,
        deletedAt: null,
        type: { in: this.getVisibleAreaTypes(user.role) },
      },
      orderBy: [{ floor: 'asc' }, { name: 'asc' }],
    });
  }

  async createArea(branchId: string, dto: CreateBranchAreaDto, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageBranch(user, branchId);
    await this.ensureBranchExists(branchId);
    return this.withUniqueConflict('Area code already exists in this branch', () =>
      this.prisma.branchArea.create({
        data: { ...dto, branchId },
      }),
    );
  }

  async updateArea(
    branchId: string,
    areaId: string,
    dto: UpdateBranchAreaDto,
    user: AuthenticatedUser,
  ) {
    await this.branchAccess.assertCanManageBranch(user, branchId);
    await this.ensureAreaInBranch(branchId, areaId);
    return this.withUniqueConflict('Area code already exists in this branch', () =>
      this.prisma.branchArea.update({
        where: { id: areaId },
        data: dto,
      }),
    );
  }

  async updateAreaStatus(
    branchId: string,
    areaId: string,
    status: BranchAreaStatus,
    user: AuthenticatedUser,
  ) {
    if (
      user.role !== AppRole.OWNER &&
      user.role !== AppRole.MANAGER &&
      user.role !== AppRole.KITCHEN
    ) {
      throw new ForbiddenException('Only OWNER, MANAGER, or KITCHEN can change area status');
    }

    if (user.role === AppRole.MANAGER) {
      await this.branchAccess.assertCanManageBranch(user, branchId);
    } else {
      await this.branchAccess.assertCanAccessBranch(user, branchId);
    }
    const area = await this.ensureAreaInBranch(branchId, areaId);

    if (
      user.role === AppRole.KITCHEN &&
      area.type !== BranchAreaType.KITCHEN &&
      area.type !== BranchAreaType.BAR
    ) {
      throw new ForbiddenException('KITCHEN can only change KITCHEN or BAR area status');
    }

    return this.prisma.branchArea.update({
      where: { id: areaId },
      data: { status },
    });
  }

  listPublicChains() {
    return this.prisma.restaurantChain.findMany({
      where: {
        deletedAt: null,
        status: RestaurantChainStatus.ACTIVE,
      },
      select: {
        id: true,
        code: true,
        name: true,
        logoUrl: true,
        website: true,
        timezone: true,
        currency: true,
        _count: {
          select: {
            branches: {
              where: { deletedAt: null, status: BranchStatus.ACTIVE },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  listPublicBranches(query: ListPublicBranchesQueryDto) {
    return this.prisma.branch.findMany({
      where: {
        deletedAt: null,
        status: BranchStatus.ACTIVE,
        chainId: query.chainId,
        city: query.city ? { equals: query.city, mode: Prisma.QueryMode.insensitive } : undefined,
        chain: {
          deletedAt: null,
          status: RestaurantChainStatus.ACTIVE,
        },
      },
      select: {
        ...branchSummarySelect,
        operatingHours: { orderBy: { dayOfWeek: 'asc' } },
      },
      orderBy: [{ city: 'asc' }, { name: 'asc' }],
    });
  }

  async getPublicBranch(id: string) {
    const branch = await this.prisma.branch.findFirst({
      where: {
        id,
        deletedAt: null,
        status: BranchStatus.ACTIVE,
        chain: {
          deletedAt: null,
          status: RestaurantChainStatus.ACTIVE,
        },
      },
      select: {
        ...branchSummarySelect,
        operatingHours: { orderBy: { dayOfWeek: 'asc' } },
        specialHours: { orderBy: { date: 'asc' } },
        areas: {
          where: {
            deletedAt: null,
            status: BranchAreaStatus.ACTIVE,
            type: { in: [BranchAreaType.DINING, BranchAreaType.PICKUP] },
          },
          select: { id: true, code: true, name: true, type: true, floor: true },
          orderBy: [{ floor: 'asc' }, { name: 'asc' }],
        },
      },
    });

    if (!branch) {
      throw new NotFoundException('Active branch not found');
    }

    return branch;
  }

  private async ensureChainExists(id: string): Promise<void> {
    const count = await this.prisma.restaurantChain.count({
      where: { id, deletedAt: null },
    });
    if (count === 0) {
      throw new NotFoundException('Restaurant chain not found');
    }
  }

  private async ensureBranchExists(id: string): Promise<void> {
    const count = await this.prisma.branch.count({
      where: { id, deletedAt: null },
    });
    if (count === 0) {
      throw new NotFoundException('Branch not found');
    }
  }

  private async ensureAreaInBranch(branchId: string, areaId: string) {
    const area = await this.prisma.branchArea.findFirst({
      where: { id: areaId, branchId, deletedAt: null },
    });
    if (!area) {
      throw new NotFoundException('Branch area not found');
    }
    return area;
  }

  private getVisibleAreaTypes(role: AppRole): BranchAreaType[] {
    switch (role) {
      case AppRole.ADMIN:
        throw new ForbiddenException('Platform ADMIN cannot access restaurant operations');
      case AppRole.OWNER:
      case AppRole.MANAGER:
        return Object.values(BranchAreaType);
      case AppRole.WAITER:
        return [BranchAreaType.DINING, BranchAreaType.PICKUP];
      case AppRole.KITCHEN:
        return [BranchAreaType.KITCHEN, BranchAreaType.BAR];
      case AppRole.CASHIER:
        return [BranchAreaType.CASHIER, BranchAreaType.PICKUP];
    }
  }

  private assertDayOfWeek(dayOfWeek: number): void {
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      throw new BadRequestException('dayOfWeek must be an integer from 0 (Sunday) to 6 (Saturday)');
    }
  }

  private normalizeHours(dto: UpsertBranchHourDto) {
    if (dto.isClosed) {
      return { isClosed: true, openTime: null, closeTime: null };
    }
    if (!dto.openTime || !dto.closeTime) {
      throw new BadRequestException('openTime and closeTime are required when isClosed is false');
    }
    if (dto.openTime === dto.closeTime) {
      throw new BadRequestException('openTime and closeTime must be different');
    }
    return { isClosed: false, openTime: dto.openTime, closeTime: dto.closeTime };
  }

  private parseDate(value: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new BadRequestException('date must use YYYY-MM-DD format');
    }
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw new BadRequestException('date is invalid');
    }
    return date;
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
