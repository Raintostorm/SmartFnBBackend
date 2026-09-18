import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  BusinessSubscriptionStatus,
  Prisma,
  RestaurantChainStatus,
  SubscriptionEventType,
  UserStatus,
  WalletStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AppRole } from '../auth/app-role.enum.js';
import { PasswordService } from '../auth/password.service.js';
import type {
  ApproveRegistrationApplicationDto,
  ChangeSubscriptionPlanDto,
  CreateServicePlanDto,
  ListRegistrationApplicationsQueryDto,
  PaginationQueryDto,
  RenewSubscriptionDto,
  SubmitRegistrationApplicationDto,
  SubscriptionStatusReasonDto,
  UpdateServicePlanDto,
} from './dto/platform-admin.dto.js';
import { PlanChangeDirection } from './dto/platform-admin.dto.js';

const servicePlanSelect = {
  id: true,
  code: true,
  name: true,
  description: true,
  monthlyPrice: true,
  maxBranches: true,
  maxAccounts: true,
  maxTables: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ServicePlanSelect;

@Injectable()
export class PlatformAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
  ) {}

  async submitRegistrationApplication(dto: SubmitRegistrationApplicationDto) {
    if (dto.requestedPlanId) {
      await this.getActivePlan(dto.requestedPlanId);
    }

    return this.prisma.registrationApplication.create({
      data: {
        applicationCode: this.generateCode('APP'),
        businessName: dto.businessName.trim(),
        taxCode: dto.taxCode?.trim(),
        representativeName: dto.representativeName.trim(),
        representativeEmail: dto.representativeEmail.trim().toLowerCase(),
        representativePhone: dto.representativePhone.trim(),
        headquartersAddress: dto.headquartersAddress?.trim(),
        requestedPlanId: dto.requestedPlanId,
      },
      include: { requestedPlan: { select: servicePlanSelect } },
    });
  }

  async listRegistrationApplications(query: ListRegistrationApplicationsQueryDto) {
    const search = query.search?.trim();
    const where: Prisma.RegistrationApplicationWhereInput = {
      status: query.status,
      ...(search
        ? {
            OR: [
              { applicationCode: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { businessName: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { representativeName: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { representativeEmail: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { taxCode: { contains: search, mode: Prisma.QueryMode.insensitive } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.registrationApplication.findMany({
        where,
        include: { requestedPlan: { select: servicePlanSelect } },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.registrationApplication.count({ where }),
    ]);
    return this.paginate(items, total, query.page, query.limit);
  }

  async getRegistrationApplication(id: string) {
    const application = await this.prisma.registrationApplication.findUnique({
      where: { id },
      include: {
        requestedPlan: { select: servicePlanSelect },
        reviewedBy: { select: { id: true, email: true } },
        ownerUser: {
          select: {
            id: true,
            email: true,
            phone: true,
            status: true,
            owner: { select: { id: true, ownerCode: true, firstName: true, lastName: true } },
          },
        },
        approvedChain: {
          select: {
            id: true,
            code: true,
            name: true,
            status: true,
            subscription: {
              include: { plan: { select: servicePlanSelect } },
            },
            wallet: { select: { id: true, currency: true, balance: true, heldBalance: true } },
            branding: true,
          },
        },
      },
    });
    if (!application) {
      throw new NotFoundException('Registration application not found');
    }
    return application;
  }

  async approveRegistrationApplication(
    id: string,
    dto: ApproveRegistrationApplicationDto,
    adminUserId: string,
  ) {
    const application = await this.prisma.registrationApplication.findUnique({ where: { id } });
    if (!application) {
      throw new NotFoundException('Registration application not found');
    }
    if (application.status !== 'PENDING') {
      throw new ConflictException('Only a pending application can be approved');
    }

    const plan = dto.planId
      ? await this.getActivePlan(dto.planId)
      : application.requestedPlanId
        ? await this.getActivePlan(application.requestedPlanId)
        : await this.getDefaultPlan();
    const ownerRole = await this.prisma.role.findUnique({ where: { code: AppRole.OWNER } });
    if (!ownerRole) {
      throw new ConflictException('OWNER role is not configured');
    }
    const duplicateUser = await this.prisma.user.count({
      where: { email: application.representativeEmail, deletedAt: null },
    });
    if (duplicateUser > 0) {
      throw new ConflictException('Representative email already belongs to an account');
    }

    const now = new Date();
    const expiresAt = this.addMonths(now, dto.subscriptionMonths);
    const setupExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const setupToken = randomBytes(32).toString('base64url');
    const placeholderPasswordHash = await this.passwordService.hash(
      randomBytes(48).toString('base64url'),
    );
    const names = this.splitName(application.representativeName);

    try {
      await this.prisma.$transaction(async (transaction) => {
        const chain = await transaction.restaurantChain.create({
          data: {
            code: this.generateCode('BIZ'),
            name: application.businessName,
            email: application.representativeEmail,
            phone: application.representativePhone,
            taxCode: application.taxCode,
            headquartersAddress: application.headquartersAddress,
          },
        });
        const ownerUser = await transaction.user.create({
          data: {
            email: application.representativeEmail,
            phone: application.representativePhone,
            passwordHash: placeholderPasswordHash,
            roleId: ownerRole.id,
            status: UserStatus.INACTIVE,
          },
        });
        const owner = await transaction.owner.create({
          data: {
            ownerCode: this.generateCode('OWN'),
            userId: ownerUser.id,
            firstName: names.firstName,
            lastName: names.lastName,
          },
        });
        await transaction.ownerChainAssignment.create({
          data: { ownerId: owner.id, chainId: chain.id, assignedById: adminUserId },
        });
        await transaction.businessBranding.create({
          data: { chainId: chain.id, displayName: application.businessName },
        });
        await transaction.businessWallet.create({ data: { chainId: chain.id } });
        const subscription = await transaction.businessSubscription.create({
          data: {
            chainId: chain.id,
            planId: plan.id,
            monthlyPrice: plan.monthlyPrice,
            startsAt: now,
            expiresAt,
          },
        });
        await transaction.businessSubscriptionEvent.create({
          data: {
            subscriptionId: subscription.id,
            type: SubscriptionEventType.CREATED,
            toPlanId: plan.id,
            changedById: adminUserId,
          },
        });
        await transaction.passwordSetupToken.create({
          data: {
            userId: ownerUser.id,
            tokenHash: this.hashToken(setupToken),
            expiresAt: setupExpiresAt,
          },
        });
        await transaction.emailOutbox.create({
          data: {
            recipient: ownerUser.email,
            subject: 'Thiết lập tài khoản Owner Smart F&B',
            template: 'OWNER_ACCOUNT_CREATED',
            payload: {
              businessName: application.businessName,
              ownerName: application.representativeName,
              loginEmail: ownerUser.email,
              setupToken,
              setupPath: '/auth/setup-password',
              expiresAt: setupExpiresAt.toISOString(),
            },
          },
        });
        await transaction.registrationApplication.update({
          where: { id },
          data: {
            status: 'APPROVED',
            reviewedById: adminUserId,
            reviewedAt: now,
            rejectionReason: null,
            approvedChainId: chain.id,
            ownerUserId: ownerUser.id,
          },
        });
      });
    } catch (error) {
      this.rethrowUniqueConflict(
        error,
        'Business code, Owner code, email, or phone already exists',
      );
    }

    return this.getRegistrationApplication(id);
  }

  async rejectRegistrationApplication(id: string, reason: string, adminUserId: string) {
    const result = await this.prisma.registrationApplication.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'REJECTED',
        rejectionReason: reason.trim(),
        reviewedById: adminUserId,
        reviewedAt: new Date(),
      },
    });
    if (result.count === 0) {
      const exists = await this.prisma.registrationApplication.count({ where: { id } });
      if (exists === 0) {
        throw new NotFoundException('Registration application not found');
      }
      throw new ConflictException('Only a pending application can be rejected');
    }
    return this.getRegistrationApplication(id);
  }

  listServicePlans() {
    return this.prisma.servicePlan.findMany({
      select: servicePlanSelect,
      orderBy: [{ isActive: 'desc' }, { monthlyPrice: 'asc' }],
    });
  }

  async createServicePlan(dto: CreateServicePlanDto) {
    try {
      return await this.prisma.servicePlan.create({ data: dto, select: servicePlanSelect });
    } catch (error) {
      this.rethrowUniqueConflict(error, 'Service plan code already exists');
    }
  }

  async updateServicePlan(id: string, dto: UpdateServicePlanDto) {
    await this.ensurePlanExists(id);
    try {
      return await this.prisma.servicePlan.update({
        where: { id },
        data: dto,
        select: servicePlanSelect,
      });
    } catch (error) {
      this.rethrowUniqueConflict(error, 'Service plan code already exists');
    }
  }

  async listBusinesses(query: PaginationQueryDto) {
    const search = query.search?.trim();
    const where: Prisma.RestaurantChainWhereInput = {
      deletedAt: null,
      ...(search
        ? {
            OR: [
              { code: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { name: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { taxCode: { contains: search, mode: Prisma.QueryMode.insensitive } },
              {
                registrationApplication: {
                  representativeName: { contains: search, mode: Prisma.QueryMode.insensitive },
                },
              },
            ],
          }
        : {}),
    };
    const [chains, total] = await Promise.all([
      this.prisma.restaurantChain.findMany({
        where,
        select: this.businessBaseSelect(),
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.restaurantChain.count({ where }),
    ]);
    const items = await Promise.all(chains.map((chain) => this.addBusinessUsage(chain)));
    return this.paginate(items, total, query.page, query.limit);
  }

  async getBusiness(id: string) {
    const chain = await this.prisma.restaurantChain.findFirst({
      where: { id, deletedAt: null },
      select: this.businessBaseSelect(),
    });
    if (!chain) {
      throw new NotFoundException('Business not found');
    }
    return this.addBusinessUsage(chain);
  }

  async renewSubscription(businessId: string, dto: RenewSubscriptionDto, adminUserId: string) {
    const subscription = await this.getSubscription(businessId);
    const baseDate = subscription.expiresAt > new Date() ? subscription.expiresAt : new Date();
    await this.prisma.$transaction(async (transaction) => {
      await transaction.businessSubscription.update({
        where: { id: subscription.id },
        data: { expiresAt: this.addMonths(baseDate, dto.months) },
      });
      await transaction.businessSubscriptionEvent.create({
        data: {
          subscriptionId: subscription.id,
          type: SubscriptionEventType.RENEWED,
          fromPlanId: subscription.planId,
          toPlanId: subscription.planId,
          changedById: adminUserId,
          note: dto.note?.trim(),
        },
      });
    });
    return this.getBusiness(businessId);
  }

  async changeSubscriptionPlan(
    businessId: string,
    dto: ChangeSubscriptionPlanDto,
    adminUserId: string,
  ) {
    const [subscription, targetPlan] = await Promise.all([
      this.getSubscription(businessId),
      this.getActivePlan(dto.planId),
    ]);
    if (subscription.planId === targetPlan.id) {
      throw new BadRequestException('Business already uses this service plan');
    }
    const currentPrice = Number(subscription.monthlyPrice);
    const targetPrice = Number(targetPlan.monthlyPrice);
    if (dto.direction === PlanChangeDirection.UPGRADE && targetPrice < currentPrice) {
      throw new BadRequestException('Target plan price is lower; use DOWNGRADE');
    }
    if (dto.direction === PlanChangeDirection.DOWNGRADE) {
      if (targetPrice > currentPrice) {
        throw new BadRequestException('Target plan price is higher; use UPGRADE');
      }
      const usage = await this.getBusinessUsageCounts(businessId);
      if (
        usage.branchCount > targetPlan.maxBranches ||
        usage.accountCount > targetPlan.maxAccounts ||
        usage.tableCount > targetPlan.maxTables
      ) {
        throw new ConflictException('Current usage exceeds one or more limits of the target plan');
      }
    }
    const eventType =
      dto.direction === PlanChangeDirection.UPGRADE
        ? SubscriptionEventType.UPGRADED
        : SubscriptionEventType.DOWNGRADED;
    await this.prisma.$transaction(async (transaction) => {
      await transaction.businessSubscription.update({
        where: { id: subscription.id },
        data: { planId: targetPlan.id, monthlyPrice: targetPlan.monthlyPrice },
      });
      await transaction.businessSubscriptionEvent.create({
        data: {
          subscriptionId: subscription.id,
          type: eventType,
          fromPlanId: subscription.planId,
          toPlanId: targetPlan.id,
          changedById: adminUserId,
          note: dto.note?.trim(),
        },
      });
    });
    return this.getBusiness(businessId);
  }

  async suspendBusiness(businessId: string, dto: SubscriptionStatusReasonDto, adminUserId: string) {
    const subscription = await this.getSubscription(businessId);
    if (subscription.status === BusinessSubscriptionStatus.SUSPENDED) {
      throw new ConflictException('Business is already suspended');
    }
    const userIds = await this.getBusinessUserIds(businessId);
    const now = new Date();
    await this.prisma.$transaction(async (transaction) => {
      await transaction.businessSubscription.update({
        where: { id: subscription.id },
        data: { status: BusinessSubscriptionStatus.SUSPENDED, suspendedAt: now },
      });
      await transaction.restaurantChain.update({
        where: { id: businessId },
        data: { status: RestaurantChainStatus.INACTIVE },
      });
      await transaction.businessWallet.updateMany({
        where: { chainId: businessId },
        data: { status: WalletStatus.SUSPENDED },
      });
      await transaction.authSession.updateMany({
        where: { userId: { in: userIds }, revokedAt: null },
        data: { revokedAt: now },
      });
      await transaction.businessSubscriptionEvent.create({
        data: {
          subscriptionId: subscription.id,
          type: SubscriptionEventType.SUSPENDED,
          fromPlanId: subscription.planId,
          toPlanId: subscription.planId,
          changedById: adminUserId,
          note: dto.reason?.trim(),
        },
      });
    });
    return this.getBusiness(businessId);
  }

  async reactivateBusiness(
    businessId: string,
    dto: SubscriptionStatusReasonDto,
    adminUserId: string,
  ) {
    const subscription = await this.getSubscription(businessId);
    if (subscription.expiresAt <= new Date()) {
      throw new ConflictException('Renew the expired subscription before reactivation');
    }
    await this.prisma.$transaction(async (transaction) => {
      await transaction.businessSubscription.update({
        where: { id: subscription.id },
        data: { status: BusinessSubscriptionStatus.ACTIVE, suspendedAt: null },
      });
      await transaction.restaurantChain.update({
        where: { id: businessId },
        data: { status: RestaurantChainStatus.ACTIVE },
      });
      await transaction.businessWallet.updateMany({
        where: { chainId: businessId },
        data: { status: WalletStatus.ACTIVE },
      });
      await transaction.businessSubscriptionEvent.create({
        data: {
          subscriptionId: subscription.id,
          type: SubscriptionEventType.REACTIVATED,
          fromPlanId: subscription.planId,
          toPlanId: subscription.planId,
          changedById: adminUserId,
          note: dto.reason?.trim(),
        },
      });
    });
    return this.getBusiness(businessId);
  }

  async resetOwnerPassword(ownerId: string, adminUserId: string) {
    const owner = await this.prisma.owner.findFirst({
      where: {
        id: ownerId,
        deletedAt: null,
        user: { deletedAt: null, role: { code: AppRole.OWNER } },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        user: { select: { id: true, email: true } },
      },
    });
    if (!owner) {
      throw new NotFoundException('Owner account not found');
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await this.prisma.$transaction(async (transaction) => {
      await transaction.passwordSetupToken.updateMany({
        where: { userId: owner.user.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      await transaction.passwordSetupToken.create({
        data: { userId: owner.user.id, tokenHash: this.hashToken(token), expiresAt },
      });
      await transaction.authSession.updateMany({
        where: { userId: owner.user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await transaction.emailOutbox.create({
        data: {
          recipient: owner.user.email,
          subject: 'Đặt lại mật khẩu Owner Smart F&B',
          template: 'OWNER_PASSWORD_RESET',
          payload: {
            ownerName: `${owner.firstName} ${owner.lastName}`,
            setupToken: token,
            setupPath: '/auth/setup-password',
            expiresAt: expiresAt.toISOString(),
            requestedByAdminId: adminUserId,
          },
        },
      });
    });
    return { message: 'Password setup email queued', ownerId: owner.id, expiresAt };
  }

  private businessBaseSelect() {
    return {
      id: true,
      code: true,
      name: true,
      taxCode: true,
      status: true,
      createdAt: true,
      registrationApplication: {
        select: {
          representativeName: true,
          representativeEmail: true,
          representativePhone: true,
        },
      },
      subscription: {
        include: {
          plan: { select: servicePlanSelect },
          events: { orderBy: { effectiveAt: 'desc' as const }, take: 20 },
        },
      },
      wallet: {
        select: { id: true, currency: true, balance: true, heldBalance: true, status: true },
      },
      ownerAssignments: {
        select: {
          owner: {
            select: {
              id: true,
              ownerCode: true,
              firstName: true,
              lastName: true,
              user: { select: { id: true, email: true, phone: true, status: true } },
            },
          },
        },
      },
      _count: { select: { branches: { where: { deletedAt: null } } } },
    } satisfies Prisma.RestaurantChainSelect;
  }

  private async addBusinessUsage<T extends { id: string; _count: { branches: number } }>(chain: T) {
    const usage = await this.getBusinessUsageCounts(chain.id);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const monthlyOrderCount = await this.prisma.order.count({
      where: { branch: { chainId: chain.id }, placedAt: { gte: monthStart } },
    });
    return {
      ...chain,
      usage: { ...usage, monthlyOrderCount },
    };
  }

  private async getBusinessUsageCounts(chainId: string) {
    const [branchCount, employeeCount, ownerCount, tableCount] = await Promise.all([
      this.prisma.branch.count({ where: { chainId, deletedAt: null } }),
      this.prisma.employee.count({
        where: { branch: { chainId }, deletedAt: null, user: { deletedAt: null } },
      }),
      this.prisma.ownerChainAssignment.count({
        where: { chainId, owner: { deletedAt: null, user: { deletedAt: null } } },
      }),
      this.prisma.restaurantTable.count({ where: { branch: { chainId }, deletedAt: null } }),
    ]);
    return { branchCount, accountCount: employeeCount + ownerCount, tableCount };
  }

  private async getBusinessUserIds(chainId: string): Promise<string[]> {
    const [owners, employees] = await Promise.all([
      this.prisma.ownerChainAssignment.findMany({
        where: { chainId },
        select: { owner: { select: { userId: true } } },
      }),
      this.prisma.employee.findMany({
        where: { branch: { chainId }, deletedAt: null },
        select: { userId: true },
      }),
    ]);
    return [
      ...new Set([
        ...owners.map(({ owner }) => owner.userId),
        ...employees.map(({ userId }) => userId),
      ]),
    ];
  }

  private async getSubscription(chainId: string) {
    const subscription = await this.prisma.businessSubscription.findUnique({
      where: { chainId },
      include: { plan: true },
    });
    if (!subscription) {
      throw new NotFoundException('Business subscription not found');
    }
    return subscription;
  }

  private async getActivePlan(id: string) {
    const plan = await this.prisma.servicePlan.findFirst({ where: { id, isActive: true } });
    if (!plan) {
      throw new NotFoundException('Active service plan not found');
    }
    return plan;
  }

  private async getDefaultPlan() {
    const plan = await this.prisma.servicePlan.findFirst({
      where: { isActive: true },
      orderBy: { monthlyPrice: 'asc' },
    });
    if (!plan) {
      throw new ConflictException('No active service plan is configured');
    }
    return plan;
  }

  private async ensurePlanExists(id: string): Promise<void> {
    if ((await this.prisma.servicePlan.count({ where: { id } })) === 0) {
      throw new NotFoundException('Service plan not found');
    }
  }

  private paginate<T>(items: T[], total: number, page: number, limit: number) {
    return { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  private generateCode(prefix: string): string {
    return `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private addMonths(date: Date, months: number): Date {
    const result = new Date(date);
    const day = result.getUTCDate();
    result.setUTCDate(1);
    result.setUTCMonth(result.getUTCMonth() + months);
    const lastDay = new Date(
      Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
    ).getUTCDate();
    result.setUTCDate(Math.min(day, lastDay));
    return result;
  }

  private splitName(fullName: string): { firstName: string; lastName: string } {
    const parts = fullName.trim().split(/\s+/);
    if (parts.length === 1) {
      return { firstName: parts[0], lastName: parts[0] };
    }
    return { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1) ?? parts[0] };
  }

  private rethrowUniqueConflict(error: unknown, message: string): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException(message);
    }
    throw error;
  }
}
