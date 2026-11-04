import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  BusinessSubscriptionStatus,
  Prisma,
  RestaurantChainStatus,
  SubscriptionEventType,
  UserStatus,
  SubscriptionCheckoutStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AppRole } from '../auth/app-role.enum.js';
import { PasswordService } from '../auth/password.service.js';
import { EmailOutboxService } from '../email/email-outbox.service.js';
import { PayosApiService } from '../payos/payos-api.service.js';
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
  brandingEnabled: true,
  multiBranchComparisonEnabled: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ServicePlanSelect;

const publicServicePlanSelect = {
  id: true,
  code: true,
  name: true,
  description: true,
  monthlyPrice: true,
  maxBranches: true,
  maxAccounts: true,
  maxTables: true,
  brandingEnabled: true,
  multiBranchComparisonEnabled: true,
} satisfies Prisma.ServicePlanSelect;

@Injectable()
export class PlatformAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly emails: EmailOutboxService,
    private readonly config: ConfigService,
    private readonly payos: PayosApiService,
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
        include: { requestedPlan: { select: servicePlanSelect }, approvedPlan: { select: servicePlanSelect } },
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
        approvedPlan: { select: servicePlanSelect },
        activationCheckouts: { orderBy: { createdAt: 'desc' }, take: 1 },
        supportActions: { orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, action: true, note: true, createdAt: true, actor: { select: { email: true } } } },
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

    const planId = dto.planId ?? application.requestedPlanId;
    if (!planId) throw new BadRequestException('Select a service plan before approval');
    const plan = await this.getActivePlan(planId);
    if (plan.code === 'TRIAL') throw new BadRequestException('Select a paid plan; Basic trial is chosen by the applicant');
    const duplicateUser = await this.prisma.user.count({
      where: { email: application.representativeEmail, deletedAt: null },
    });
    if (duplicateUser > 0) {
      throw new ConflictException('Representative email already belongs to an account');
    }

    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60_000);
    const email = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.registrationApplication.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'APPROVED', approvedPlanId: plan.id, reviewedById: adminUserId, reviewedAt: now, rejectionReason: null, activationTokenHash: this.hashToken(token), activationExpiresAt: expiresAt },
      });
      if (updated.count !== 1) throw new ConflictException('Application was already reviewed');
      return tx.emailOutbox.create({ data: {
        recipient: application.representativeEmail,
        subject: 'Kích hoạt doanh nghiệp Smart F&B',
        template: 'REGISTRATION_ACTIVATION',
        payload: { businessName: application.businessName, employeeName: application.representativeName, setupToken: token, setupPath: '/activate', expiresAt: expiresAt.toISOString(), planName: plan.name },
      } });
    });
    await this.emails.deliver(email.id);

    return this.getRegistrationApplication(id);
  }

  async getActivation(token: string) {
    const application = await this.findActivation(token);
    return { businessName: application.businessName, representativeEmail: application.representativeEmail, approvedPlan: application.approvedPlan, expiresAt: application.activationExpiresAt, trialAvailable: application.approvedPlan?.code === 'BASIC' };
  }

  async activateTrial(token: string) {
    const application = await this.findActivation(token);
    if (application.approvedPlan?.code !== 'BASIC') throw new BadRequestException('The 14-day trial is available only for Basic');
    const trialPlan = await this.getTrialPlan();
    const emailId = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${application.id}))`;
      const fresh = await tx.registrationApplication.findUniqueOrThrow({ where: { id: application.id } });
      if (fresh.status !== 'APPROVED' || fresh.activationTokenHash !== this.hashToken(token) || !fresh.activationExpiresAt || fresh.activationExpiresAt <= new Date()) throw new ConflictException('Activation link is expired or already used');
      return this.provisionRegistration(tx, fresh, trialPlan, true);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    await this.emails.deliver(emailId);
    return { activated: true, loginEmail: application.representativeEmail };
  }

  async createActivationCheckout(token: string) {
    const application = await this.findActivation(token);
    const plan = application.approvedPlan;
    if (!plan || !plan.isActive || plan.monthlyPrice.lte(0)) throw new BadRequestException('Approved paid plan is unavailable');
    const amount = Number(plan.monthlyPrice);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new BadRequestException('Plan price must be a whole VND amount');
    const orderCode = String(Date.now() * 1000 + Math.floor(Math.random() * 1000));
    const checkout = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${application.id}))`;
      const fresh = await tx.registrationApplication.findUniqueOrThrow({ where: { id: application.id } });
      if (fresh.status !== 'APPROVED' || fresh.activationTokenHash !== this.hashToken(token) || fresh.approvedPlanId !== plan.id || !fresh.activationExpiresAt || fresh.activationExpiresAt <= new Date()) throw new ConflictException('Activation link or approved plan changed');
      const pending = await tx.registrationCheckout.findFirst({ where: { applicationId: application.id, status: 'PENDING' }, orderBy: { createdAt: 'desc' } });
      if (pending && Date.now() - pending.createdAt.getTime() < 15 * 60_000 && pending.planId === plan.id && pending.checkoutUrl) return pending;
      if (pending) await tx.registrationCheckout.update({ where: { id: pending.id }, data: { status: 'FAILED' } });
      return tx.registrationCheckout.create({ data: { applicationId: application.id, planId: plan.id, providerOrderCode: orderCode, amount } });
    });
    if (checkout.checkoutUrl) return { id: checkout.id, checkoutUrl: checkout.checkoutUrl, status: checkout.status };
    const webUrl = this.config.getOrThrow<string>('PUBLIC_WEB_URL').replace(/\/+$/, '');
    try {
      const payment = await this.payos.createPayment(this.payosCredentials(), {
        orderCode: Number(orderCode), amount, description: `SmartFnB ${plan.code}`.slice(0, 25),
        returnUrl: `${webUrl}/activate?token=${encodeURIComponent(token)}&checkout=${checkout.id}`,
        cancelUrl: `${webUrl}/activate?token=${encodeURIComponent(token)}&checkout=${checkout.id}&cancelled=1`,
        expiredAt: Math.floor(Date.now() / 1000) + 15 * 60,
      });
      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${application.id}))`;
        const fresh = await tx.registrationApplication.findUniqueOrThrow({ where: { id: application.id } });
        const currentCheckout = await tx.registrationCheckout.findUniqueOrThrow({ where: { id: checkout.id } });
        if (fresh.status !== 'APPROVED' || fresh.activationTokenHash !== this.hashToken(token) || fresh.approvedPlanId !== plan.id || currentCheckout.status !== 'PENDING') throw new ConflictException('Activation changed while creating payment link');
        return tx.registrationCheckout.update({ where: { id: checkout.id }, data: { checkoutUrl: payment.checkoutUrl, paymentLinkId: payment.paymentLinkId } });
      });
      return { id: updated.id, checkoutUrl: updated.checkoutUrl, status: updated.status };
    } catch (error) {
      await this.prisma.registrationCheckout.update({ where: { id: checkout.id }, data: { status: 'FAILED' } });
      throw error;
    }
  }

  async getActivationCheckout(token: string, checkoutId: string) {
    const application = await this.findActivation(token, true);
    const checkout = await this.prisma.registrationCheckout.findFirst({ where: { id: checkoutId, applicationId: application.id } });
    if (!checkout) throw new NotFoundException('Activation checkout not found');
    return { id: checkout.id, status: checkout.status, checkoutUrl: checkout.checkoutUrl, reviewReason: checkout.reviewReason };
  }

  async completePaidActivation(orderCode: string, amount: number): Promise<boolean> {
    const checkout = await this.prisma.registrationCheckout.findUnique({ where: { providerOrderCode: orderCode } });
    if (!checkout) return false;
    const emailId = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${orderCode}))`;
      const fresh = await tx.registrationCheckout.findUniqueOrThrow({ where: { id: checkout.id } });
      if (fresh.status === SubscriptionCheckoutStatus.PAID || fresh.status === SubscriptionCheckoutStatus.NEEDS_REVIEW) return null;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${fresh.applicationId}))`;
      const application = await tx.registrationApplication.findUniqueOrThrow({ where: { id: fresh.applicationId } });
      if (!Number.isSafeInteger(amount) || !fresh.amount.equals(amount) || fresh.status !== SubscriptionCheckoutStatus.PENDING || application.status !== 'APPROVED' || application.approvedPlanId !== fresh.planId || !application.activationExpiresAt || application.activationExpiresAt <= new Date()) {
        await tx.registrationCheckout.update({ where: { id: fresh.id }, data: { status: 'NEEDS_REVIEW', paidAt: new Date(), reviewReason: 'AMOUNT_OR_ACTIVATION_STATE_MISMATCH' } });
        return null;
      }
      const plan = await tx.servicePlan.findUniqueOrThrow({ where: { id: fresh.planId } });
      const sentEmailId = await this.provisionRegistration(tx, application, plan, false);
      await tx.registrationCheckout.update({ where: { id: fresh.id }, data: { status: 'PAID', paidAt: new Date() } });
      return sentEmailId;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (emailId) await this.emails.deliver(emailId);
    return true;
  }

  async changeApprovedPlan(id: string, planId: string, note: string, actorUserId: string) {
    const plan = await this.getActivePlan(planId);
    if (plan.code === 'TRIAL') throw new BadRequestException('Select a paid plan');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000);
    const emailId = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const application = await tx.registrationApplication.findUnique({ where: { id } });
      if (!application || application.status !== 'APPROVED') throw new ConflictException('Only approved applications awaiting activation can change plan');
      await tx.registrationApplication.update({ where: { id }, data: { approvedPlanId: planId, activationTokenHash: this.hashToken(token), activationExpiresAt: expiresAt } });
      await tx.registrationCheckout.updateMany({ where: { applicationId: id, status: 'PENDING' }, data: { status: 'FAILED' } });
      await tx.platformSupportAction.create({ data: { actorUserId, applicationId: id, action: 'CHANGE_APPROVED_PLAN', note: note.trim(), details: { fromPlanId: application.approvedPlanId, toPlanId: planId } } });
      const email = await tx.emailOutbox.create({ data: { recipient: application.representativeEmail, subject: 'Cập nhật gói kích hoạt Smart F&B', template: 'REGISTRATION_ACTIVATION', payload: { businessName: application.businessName, employeeName: application.representativeName, setupToken: token, setupPath: '/activate', expiresAt: expiresAt.toISOString(), planName: plan.name } } });
      return email.id;
    });
    await this.emails.deliver(emailId);
    return this.getRegistrationApplication(id);
  }

  async resendActivation(id: string, note: string, actorUserId: string) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000);
    const email = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const application = await tx.registrationApplication.findUnique({ where: { id }, include: { approvedPlan: true } });
      if (!application || application.status !== 'APPROVED') throw new ConflictException('Only approved applications awaiting activation can receive a new link');
      await tx.registrationApplication.update({ where: { id }, data: { activationTokenHash: this.hashToken(token), activationExpiresAt: expiresAt } });
      await tx.registrationCheckout.updateMany({ where: { applicationId: id, status: 'PENDING' }, data: { status: 'FAILED' } });
      await tx.platformSupportAction.create({ data: { actorUserId, applicationId: id, action: 'RESEND_ACTIVATION', note: note.trim() } });
      return tx.emailOutbox.create({ data: { recipient: application.representativeEmail, subject: 'Liên kết kích hoạt Smart F&B mới', template: 'REGISTRATION_ACTIVATION', payload: { businessName: application.businessName, employeeName: application.representativeName, setupToken: token, setupPath: '/activate', expiresAt: expiresAt.toISOString(), planName: application.approvedPlan?.name } } });
    });
    await this.emails.deliver(email.id);
    return this.getRegistrationApplication(id);
  }

  private async findActivation(token: string, allowActivated = false) {
    const application = await this.prisma.registrationApplication.findUnique({ where: { activationTokenHash: this.hashToken(token) }, include: { approvedPlan: { select: servicePlanSelect } } });
    if (!application || (application.status !== 'APPROVED' && !(allowActivated && application.status === 'ACTIVATED')) || !application.activationExpiresAt || application.activationExpiresAt <= new Date()) throw new NotFoundException('Activation link is invalid or expired');
    return application;
  }

  private async provisionRegistration(tx: Prisma.TransactionClient, application: { id: string; businessName: string; representativeName: string; representativeEmail: string; representativePhone: string; taxCode: string | null; headquartersAddress: string | null; reviewedById: string | null }, plan: { id: string; monthlyPrice: Prisma.Decimal }, trial: boolean): Promise<string> {
    const ownerRole = await tx.role.findUnique({ where: { code: AppRole.OWNER } });
    if (!ownerRole) throw new ConflictException('OWNER role is not configured');
    const now = new Date();
    const expiresAt = trial ? new Date(now.getTime() + 14 * 24 * 60 * 60_000) : this.addMonths(now, 1);
    const setupExpiresAt = new Date(now.getTime() + 24 * 60 * 60_000);
    const setupToken = randomBytes(32).toString('base64url');
    const passwordHash = await this.passwordService.hash(randomBytes(48).toString('base64url'));
    const names = this.splitName(application.representativeName);
    const chain = await tx.restaurantChain.create({ data: { code: this.generateCode('BIZ'), name: application.businessName, email: application.representativeEmail, phone: application.representativePhone, taxCode: application.taxCode, headquartersAddress: application.headquartersAddress } });
    const user = await tx.user.create({ data: { email: application.representativeEmail, phone: application.representativePhone, passwordHash, roleId: ownerRole.id, status: UserStatus.INACTIVE } });
    const owner = await tx.owner.create({ data: { ownerCode: this.generateCode('OWN'), userId: user.id, firstName: names.firstName, lastName: names.lastName } });
    await tx.ownerChainAssignment.create({ data: { ownerId: owner.id, chainId: chain.id, assignedById: application.reviewedById } });
    await tx.businessBranding.create({ data: { chainId: chain.id, displayName: application.businessName } });
    const subscription = await tx.businessSubscription.create({ data: { chainId: chain.id, planId: plan.id, monthlyPrice: plan.monthlyPrice, startsAt: now, expiresAt, trialStartedAt: trial ? now : null, trialEndsAt: trial ? expiresAt : null } });
    await tx.businessSubscriptionEvent.create({ data: { subscriptionId: subscription.id, type: SubscriptionEventType.CREATED, toPlanId: plan.id, changedById: application.reviewedById, note: trial ? 'Basic trial chosen during activation' : 'First month paid through platform PayOS' } });
    await tx.passwordSetupToken.create({ data: { userId: user.id, tokenHash: this.hashToken(setupToken), expiresAt: setupExpiresAt } });
    const email = await tx.emailOutbox.create({ data: { recipient: user.email, subject: 'Thiết lập tài khoản Owner Smart F&B', template: 'OWNER_ACCOUNT_CREATED', payload: { businessName: application.businessName, employeeName: application.representativeName, loginEmail: user.email, setupToken, setupPath: '/setup-password', expiresAt: setupExpiresAt.toISOString() } } });
    await tx.registrationApplication.update({ where: { id: application.id }, data: { status: 'ACTIVATED', activatedAt: now, approvedChainId: chain.id, ownerUserId: user.id } });
    return email.id;
  }

  private payosCredentials() {
    const clientId = this.config.get<string>('PLATFORM_PAYOS_CLIENT_ID')?.trim();
    const apiKey = this.config.get<string>('PLATFORM_PAYOS_API_KEY')?.trim();
    const checksumKey = this.config.get<string>('PLATFORM_PAYOS_CHECKSUM_KEY')?.trim();
    if (!clientId || !apiKey || !checksumKey) throw new ConflictException('Platform PayOS credentials are not configured');
    return { clientId, apiKey, checksumKey };
  }

  async rejectRegistrationApplication(id: string, reason: string, adminUserId: string) {
    const rejectionReason = reason.trim();
    const emailId = await this.prisma.$transaction(async (transaction) => {
      const result = await transaction.registrationApplication.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: 'REJECTED',
          rejectionReason,
          reviewedById: adminUserId,
          reviewedAt: new Date(),
        },
      });
      if (result.count === 0) {
        const exists = await transaction.registrationApplication.count({ where: { id } });
        if (exists === 0) {
          throw new NotFoundException('Registration application not found');
        }
        throw new ConflictException('Only a pending application can be rejected');
      }

      const application = await transaction.registrationApplication.findUniqueOrThrow({
        where: { id },
        select: {
          applicationCode: true,
          businessName: true,
          representativeName: true,
          representativeEmail: true,
        },
      });
      const email = await transaction.emailOutbox.create({
        data: {
          recipient: application.representativeEmail,
          subject: 'Kết quả hồ sơ đăng ký Smart F&B',
          template: 'REGISTRATION_APPLICATION_REJECTED',
          payload: {
            applicationCode: application.applicationCode,
            businessName: application.businessName,
            representativeName: application.representativeName,
            rejectionReason,
          },
        },
      });
      return email.id;
    });
    await this.emails.deliver(emailId);
    return this.getRegistrationApplication(id);
  }

  listServicePlans() {
    return this.prisma.servicePlan.findMany({
      select: servicePlanSelect,
      orderBy: [{ isActive: 'desc' }, { monthlyPrice: 'asc' }],
    });
  }

  listPublicServicePlans() {
    return this.prisma.servicePlan.findMany({
      where: { isActive: true, code: { not: 'TRIAL' }, monthlyPrice: { gt: 0 } },
      select: publicServicePlanSelect,
      orderBy: [{ monthlyPrice: 'asc' }, { name: 'asc' }],
    });
  }

  async createServicePlan(dto: CreateServicePlanDto) {
    if (dto.code === 'TRIAL') {
      throw new BadRequestException('TRIAL is reserved for automatic registration approval');
    }
    try {
      return await this.prisma.servicePlan.create({
        data: { ...dto, maxTables: dto.maxTables ?? 1 },
        select: servicePlanSelect,
      });
    } catch (error) {
      this.rethrowUniqueConflict(error, 'Service plan code already exists');
    }
  }

  async updateServicePlan(id: string, dto: UpdateServicePlanDto) {
    await this.ensurePlanExists(id);
    const existing = await this.prisma.servicePlan.findUniqueOrThrow({ where: { id } });
    if (existing.code === 'TRIAL' || dto.code === 'TRIAL') {
      throw new BadRequestException('TRIAL is managed automatically from the BASIC plan');
    }
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

  async scheduleNextPlan(businessId: string, planId: string, note: string, actorUserId: string) {
    const [subscription, target] = await Promise.all([this.getSubscription(businessId), this.getActivePlan(planId)]);
    if (subscription.plan.code === 'TRIAL' || target.code === 'TRIAL') throw new ConflictException('Use registration activation or trial checkout for a trial business');
    if (subscription.status !== BusinessSubscriptionStatus.ACTIVE) throw new ConflictException('Business subscription is not active');
    if (subscription.planId === target.id) throw new BadRequestException('Business already uses this plan');
    if (target.monthlyPrice.lt(subscription.monthlyPrice)) {
      const usage = await this.getBusinessUsageCounts(businessId);
      if (usage.branchCount > target.maxBranches || usage.accountCount > target.maxAccounts || usage.tableCount > target.maxTables) throw new ConflictException('Current usage exceeds target plan limits');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.businessSubscription.update({ where: { id: subscription.id }, data: { nextPlanId: target.id } });
      await tx.subscriptionCheckout.updateMany({ where: { chainId: businessId, status: 'PENDING' }, data: { status: 'FAILED' } });
      await tx.platformSupportAction.create({ data: { actorUserId, chainId: businessId, action: 'SCHEDULE_NEXT_PLAN', note: note.trim(), details: { fromPlanId: subscription.planId, toPlanId: target.id } } });
    });
    return this.getBusiness(businessId);
  }

  async renewSubscription(businessId: string, dto: RenewSubscriptionDto, adminUserId: string) {
    const subscription = await this.getSubscription(businessId);
    const scheduledPlan = subscription.nextPlanId ? await this.getActivePlan(subscription.nextPlanId) : null;
    if (subscription.plan.code === 'TRIAL') {
      throw new ConflictException('The 14-day trial cannot be renewed');
    }
    const baseDate = subscription.expiresAt > new Date() ? subscription.expiresAt : new Date();
    await this.prisma.$transaction(async (transaction) => {
      await transaction.businessSubscription.update({
        where: { id: subscription.id },
        data: { expiresAt: this.addMonths(baseDate, dto.months), ...(scheduledPlan ? { planId: scheduledPlan.id, monthlyPrice: scheduledPlan.monthlyPrice, nextPlanId: null } : {}) },
      });
      await transaction.businessSubscriptionEvent.create({
        data: {
          subscriptionId: subscription.id,
          type: SubscriptionEventType.RENEWED,
          fromPlanId: subscription.planId,
          toPlanId: subscription.nextPlanId ?? subscription.planId,
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
    if (subscription.plan.code === 'TRIAL' || targetPlan.code === 'TRIAL') {
      throw new ConflictException('Trial conversion requires a verified platform PayOS payment');
    }
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
          nextPlan: { select: servicePlanSelect },
          events: { orderBy: { effectiveAt: 'desc' as const }, take: 20 },
        },
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

  private async getTrialPlan() {
    const basic = await this.prisma.servicePlan.findUnique({ where: { code: 'BASIC' } });
    if (!basic?.isActive) {
      throw new ConflictException('Active BASIC plan is required before approving a trial');
    }
    return this.prisma.servicePlan.upsert({
      where: { code: 'TRIAL' },
      create: {
        code: 'TRIAL',
        name: 'Dùng thử 14 ngày',
        description: 'Gói dùng thử với hạn mức tương đương BASIC',
        monthlyPrice: 0,
        maxBranches: basic.maxBranches,
        maxAccounts: basic.maxAccounts,
        maxTables: basic.maxTables,
        brandingEnabled: basic.brandingEnabled,
        multiBranchComparisonEnabled: basic.multiBranchComparisonEnabled,
      },
      update: {
        monthlyPrice: 0,
        maxBranches: basic.maxBranches,
        maxAccounts: basic.maxAccounts,
        maxTables: basic.maxTables,
        brandingEnabled: basic.brandingEnabled,
        multiBranchComparisonEnabled: basic.multiBranchComparisonEnabled,
        isActive: true,
      },
    });
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
