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
  CreateServicePlanDto,
  ListRegistrationApplicationsQueryDto,
  PaginationQueryDto,
  RenewSubscriptionDto,
  SubmitRegistrationApplicationDto,
  SubscriptionStatusReasonDto,
  UpdateServicePlanDto,
} from './dto/platform-admin.dto.js';
import { countUsage, effectiveLimits } from '../subscription/subscription-usage.js';
import { SubscriptionScheduleService } from '../subscription/subscription-schedule.service.js';

const servicePlanSelect = {
  id: true,
  code: true,
  name: true,
  description: true,
  monthlyPrice: true,
  maxBranches: true,
  maxAccounts: true,
  extraBranchPrice: true,
  extraBranchAccounts: true,
  extraAccountPackPrice: true,
  extraBranchEnabled: true,
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
  extraBranchPrice: true,
  extraBranchAccounts: true,
  extraAccountPackPrice: true,
  extraBranchEnabled: true,
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
    private readonly schedule: SubscriptionScheduleService,
  ) {}

  async submitRegistrationApplication(dto: SubmitRegistrationApplicationDto) {
    if (dto.trialRequested && dto.requestedPlanId) throw new BadRequestException('Choose either trial or a paid plan');
    if (!dto.trialRequested && !dto.requestedPlanId) throw new BadRequestException('Choose trial or a paid plan');
    const plan = dto.trialRequested
      ? await this.getTrialPlan()
      : await this.getActivePlan(dto.requestedPlanId!);
    if (!dto.trialRequested && (plan.code === 'TRIAL' || plan.monthlyPrice.lte(0))) {
      throw new BadRequestException('Choose an active paid plan');
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
        requestedPlanId: plan.id,
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

  /**
   * PS-01 / 30.3 "Đã duyệt — chờ kích hoạt". Only registration and platform billing data
   * (BR-07): never the business's orders, menu, staff or PayOS sales keys.
   * "QR created" means a platform PayOS link exists for the current link; it is not "paid".
   */
  async listAwaitingActivation(query: PaginationQueryDto) {
    const search = query.search?.trim();
    const where: Prisma.RegistrationApplicationWhereInput = {
      status: 'APPROVED',
      ...(search ? { OR: [
        { applicationCode: { contains: search, mode: Prisma.QueryMode.insensitive } },
        { businessName: { contains: search, mode: Prisma.QueryMode.insensitive } },
        { representativeEmail: { contains: search, mode: Prisma.QueryMode.insensitive } },
      ] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.registrationApplication.findMany({
        where,
        select: {
          id: true, applicationCode: true, businessName: true, representativeName: true, representativeEmail: true, representativePhone: true,
          requestedPlanId: true, reviewedAt: true, activationSentAt: true, activationExpiresAt: true, activationLastOpenedAt: true,
          approvedPlan: { select: { id: true, code: true, name: true, monthlyPrice: true } },
          activationCheckouts: { orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, planId: true, amount: true, status: true, checkoutUrl: true, paidAt: true, createdAt: true } },
        },
        orderBy: [{ activationExpiresAt: 'asc' }, { createdAt: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.registrationApplication.count({ where }),
    ]);
    const now = Date.now();
    const items = rows.map(({ activationCheckouts, ...row }) => {
      const sentAt = row.activationSentAt;
      // The link is valid for seven days. Use its issue time for QR filtering even if email delivery
      // is still pending; a previous link's checkout must not appear under the new link.
      const issuedAt = row.activationExpiresAt ? new Date(row.activationExpiresAt.getTime() - 7 * 24 * 60 * 60_000) : row.reviewedAt;
      const current = activationCheckouts.filter((c) => c.planId === row.approvedPlan?.id && (!issuedAt || c.createdAt >= issuedAt));
      const qr = current.find((c) => !!c.checkoutUrl) ?? null;
      const latest = current[0] ?? null;
      return {
        ...row,
        activationSentAt: sentAt,
        linkExpired: !row.activationExpiresAt || row.activationExpiresAt.getTime() <= now,
        firstPeriodQr: {
          created: !!qr,
          createdAt: qr?.createdAt ?? null,
          latestStatus: latest?.status ?? null,
          paid: current.some((c) => c.status === 'PAID'),
          needsReview: current.some((c) => c.status === 'NEEDS_REVIEW'),
          amount: latest ? String(latest.amount) : null,
        },
      };
    });
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

    if (application.requestedPlanId && dto.planId && dto.planId !== application.requestedPlanId) {
      throw new BadRequestException('Approve the plan selected by the applicant');
    }
    const planId = application.requestedPlanId ?? dto.planId;
    if (!planId) throw new BadRequestException('Select a service plan before approval');
    const plan = await this.getActivePlan(planId);
    if (plan.code === 'TRIAL' && !application.requestedPlanId) throw new BadRequestException('Trial must be chosen by the applicant');
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
        data: { status: 'APPROVED', approvedPlanId: plan.id, reviewedById: adminUserId, reviewedAt: now, rejectionReason: null, activationTokenHash: this.hashToken(token), activationExpiresAt: expiresAt, activationSentAt: null, activationLastOpenedAt: null },
      });
      if (updated.count !== 1) throw new ConflictException('Application was already reviewed');
      // BR-06: review decisions are audited with actor, time and the approved plan.
      await tx.platformSupportAction.create({ data: { actorUserId: adminUserId, applicationId: id, action: 'APPROVE_APPLICATION', note: dto.note?.trim() || 'Duyệt hồ sơ đăng ký', details: { fromStatus: 'PENDING', toStatus: 'APPROVED', planId: plan.id, activationExpiresAt: expiresAt.toISOString() } } });
      return tx.emailOutbox.create({ data: {
        recipient: application.representativeEmail,
        subject: 'Kích hoạt doanh nghiệp Smart F&B',
        template: 'REGISTRATION_ACTIVATION',
        payload: { businessName: application.businessName, employeeName: application.representativeName, setupTokenEncrypted: this.emails.sealSetupToken(token), setupPath: '/activate', expiresAt: expiresAt.toISOString(), planName: plan.name },
      } });
    });
    await this.emails.deliver(email.id);

    return this.getRegistrationApplication(id);
  }

  async getActivation(token: string) {
    const application = await this.findActivation(token);
    // PS-01 / 30.3: Platform Staff sees when the current link was last opened. Best effort only.
    await this.prisma.registrationApplication.updateMany({ where: { id: application.id, activationTokenHash: this.hashToken(token) }, data: { activationLastOpenedAt: new Date() } }).catch(() => undefined);
    return { businessName: application.businessName, representativeEmail: application.representativeEmail, approvedPlan: application.approvedPlan, expiresAt: application.activationExpiresAt, trialAvailable: application.approvedPlan?.code === 'TRIAL' || (!application.requestedPlanId && application.approvedPlan?.code === 'BASIC'), activationMode: application.approvedPlan?.code === 'TRIAL' ? 'TRIAL' : application.requestedPlanId ? 'PAID' : 'LEGACY' };
  }

  async activateTrial(token: string) {
    const application = await this.findActivation(token);
    if (application.approvedPlan?.code !== 'TRIAL' && !(application.requestedPlanId == null && application.approvedPlan?.code === 'BASIC')) throw new BadRequestException('Trial was not selected for this application');
    const trialPlan = await this.getTrialPlan();
    const emailId = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${application.id}))`;
      const fresh = await tx.registrationApplication.findUniqueOrThrow({ where: { id: application.id } });
      if (fresh.status !== 'APPROVED' || fresh.activationTokenHash !== this.hashToken(token) || fresh.approvedPlanId !== application.approvedPlanId || !fresh.activationExpiresAt || fresh.activationExpiresAt <= new Date()) throw new ConflictException('Activation link is expired or already used');
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
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${application.id}))`;
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
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${application.id}))`;
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
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${orderCode}))`;
      const fresh = await tx.registrationCheckout.findUniqueOrThrow({ where: { id: checkout.id } });
      if (fresh.status === SubscriptionCheckoutStatus.PAID || fresh.status === SubscriptionCheckoutStatus.NEEDS_REVIEW) return null;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${fresh.applicationId}))`;
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

  async confirmRegistrationCheckoutManually(checkoutId: string, note: string, actorUserId: string) {
    const emailId = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${checkoutId}))`;
        const checkout = await tx.registrationCheckout.findUnique({ where: { id: checkoutId } });
        if (!checkout) throw new NotFoundException('Registration invoice not found');
        if (checkout.status !== SubscriptionCheckoutStatus.NEEDS_REVIEW) {
          throw new ConflictException('Only an invoice that needs review can be confirmed manually');
        }
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${checkout.applicationId}))`;
        const application = await tx.registrationApplication.findUnique({
          where: { id: checkout.applicationId },
        });
        if (!application || application.status !== 'APPROVED' || application.approvedPlanId !== checkout.planId) {
          throw new ConflictException('Registration state changed; this invoice cannot be confirmed manually');
        }
        const plan = await tx.servicePlan.findUniqueOrThrow({ where: { id: checkout.planId } });
        const ownerEmailId = await this.provisionRegistration(tx, application, plan, false);
        const now = new Date();
        await tx.registrationCheckout.update({
          where: { id: checkout.id },
          data: { status: SubscriptionCheckoutStatus.PAID, paidAt: now },
        });
        await tx.platformSupportAction.create({
          data: {
            actorUserId,
            applicationId: application.id,
            action: 'CONFIRM_REGISTRATION_INVOICE',
            note: note.trim(),
            details: { checkoutId: checkout.id, previousReviewReason: checkout.reviewReason },
          },
        });
        return ownerEmailId;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    await this.emails.deliver(emailId);
    return this.prisma.registrationCheckout.findUniqueOrThrow({
      where: { id: checkoutId },
      select: { id: true, status: true, paidAt: true, reviewReason: true },
    });
  }


  async changeApprovedPlan(id: string, planId: string, note: string, actorUserId: string) {
    const plan = await this.getActivePlan(planId);
    if (plan.code === 'TRIAL') throw new BadRequestException('Select a paid plan');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000);
    const emailId = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const application = await tx.registrationApplication.findUnique({ where: { id } });
      if (!application || application.status !== 'APPROVED') throw new ConflictException('Only approved applications awaiting activation can change plan');
      if (application.requestedPlanId) throw new ConflictException('The applicant-selected plan cannot be changed after approval');
      await tx.registrationApplication.update({ where: { id }, data: { approvedPlanId: planId, activationTokenHash: this.hashToken(token), activationExpiresAt: expiresAt, activationSentAt: null, activationLastOpenedAt: null } });
      await tx.registrationCheckout.updateMany({ where: { applicationId: id, status: 'PENDING' }, data: { status: 'FAILED' } });
      await tx.platformSupportAction.create({ data: { actorUserId, applicationId: id, action: 'CHANGE_APPROVED_PLAN', note: note.trim(), details: { fromPlanId: application.approvedPlanId, toPlanId: planId } } });
      const email = await tx.emailOutbox.create({ data: { recipient: application.representativeEmail, subject: 'Cập nhật gói kích hoạt Smart F&B', template: 'REGISTRATION_ACTIVATION', payload: { businessName: application.businessName, employeeName: application.representativeName, setupTokenEncrypted: this.emails.sealSetupToken(token), setupPath: '/activate', expiresAt: expiresAt.toISOString(), planName: plan.name } } });
      return email.id;
    });
    await this.emails.deliver(emailId);
    return this.getRegistrationApplication(id);
  }

  async resendActivation(id: string, note: string, actorUserId: string) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000);
    const email = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const application = await tx.registrationApplication.findUnique({ where: { id }, include: { approvedPlan: true } });
      if (!application || application.status !== 'APPROVED') throw new ConflictException('Only approved applications awaiting activation can receive a new link');
      await tx.registrationApplication.update({ where: { id }, data: { activationTokenHash: this.hashToken(token), activationExpiresAt: expiresAt, activationSentAt: null, activationLastOpenedAt: null } });
      await tx.registrationCheckout.updateMany({ where: { applicationId: id, status: 'PENDING' }, data: { status: 'FAILED' } });
      await tx.platformSupportAction.create({ data: { actorUserId, applicationId: id, action: 'RESEND_ACTIVATION', note: note.trim() } });
      return tx.emailOutbox.create({ data: { recipient: application.representativeEmail, subject: 'Liên kết kích hoạt Smart F&B mới', template: 'REGISTRATION_ACTIVATION', payload: { businessName: application.businessName, employeeName: application.representativeName, setupTokenEncrypted: this.emails.sealSetupToken(token), setupPath: '/activate', expiresAt: expiresAt.toISOString(), planName: application.approvedPlan?.name } } });
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
    // Freeze the first period like every later one (BR-72); trial periods carry the TRIAL limits.
    const fullPlan = await tx.servicePlan.findUniqueOrThrow({ where: { id: plan.id } });
    await this.schedule.recordPeriod(tx, {
      subscriptionId: subscription.id, chainId: chain.id, plan: fullPlan, selection: { extraBranches: 0, accountPacks: 0 },
      monthlyPrice: Math.round(Number(plan.monthlyPrice)), extraBranchPrice: 0, accountPackPrice: 0,
      startsAt: now, endsAt: expiresAt, invoiceId: null, source: trial ? 'TRIAL' : 'ACTIVATION', keepBranchIds: null, keepAccountIds: null,
    });
    await tx.subscriptionPeriod.updateMany({ where: { subscriptionId: subscription.id, startsAt: now }, data: { appliedAt: now } });
    await tx.businessSubscriptionEvent.create({ data: { subscriptionId: subscription.id, type: SubscriptionEventType.CREATED, toPlanId: plan.id, changedById: application.reviewedById, note: trial ? 'Basic trial chosen during activation' : 'First month paid through platform PayOS' } });
    await tx.passwordSetupToken.create({ data: { userId: user.id, tokenHash: this.hashToken(setupToken), expiresAt: setupExpiresAt } });
    const email = await tx.emailOutbox.create({ data: { recipient: user.email, subject: 'Thiết lập tài khoản Brand Manager Smart F&B', template: 'OWNER_ACCOUNT_CREATED', payload: { businessName: application.businessName, employeeName: application.representativeName, loginEmail: user.email, setupToken, setupPath: '/setup-password', expiresAt: setupExpiresAt.toISOString() } } });
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
      await transaction.platformSupportAction.create({ data: { actorUserId: adminUserId, applicationId: id, action: 'REJECT_APPLICATION', note: rejectionReason, details: { fromStatus: 'PENDING', toStatus: 'REJECTED' } } });

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

  /** Legacy single-plan endpoint; same audited registration as {@link scheduleNextPeriod}. */
  async scheduleNextPlan(businessId: string, planId: string, note: string, actorUserId: string, role: 'PLATFORM_STAFF' | 'PLATFORM_ADMIN' = 'PLATFORM_STAFF') {
    await this.ensureBusiness(businessId);
    await this.schedule.putNextPlan(businessId, planId, {}, { role, userId: actorUserId, note });
    return this.getBusiness(businessId);
  }

  /**
   * Platform Staff (and Admin) register the next period on the customer's request: plan, add-ons and
   * the BR-11 keep lists, with a mandatory note and an audit row. Never pays and never changes the
   * current period (BR-10, BR-74).
   */
  async scheduleNextPeriod(
    businessId: string,
    dto: { planId?: string; extraBranches?: number; accountPacks?: number; keepBranchIds?: string[]; keepAccountIds?: string[]; clear?: boolean; note: string },
    actorUserId: string,
    role: 'PLATFORM_STAFF' | 'PLATFORM_ADMIN',
  ) {
    await this.ensureBusiness(businessId);
    const actor = { role, userId: actorUserId, note: dto.note };
    const keep = { keepBranchIds: dto.keepBranchIds, keepAccountIds: dto.keepAccountIds };
    return dto.clear
      ? this.schedule.clearNextPlan(businessId, keep, actor)
      : this.schedule.register(businessId, { planId: dto.planId, extraBranches: dto.extraBranches, accountPacks: dto.accountPacks, ...keep }, actor);
  }

  async getNextPeriod(businessId: string, draft?: { planId?: string; extraBranches?: number; accountPacks?: number }) {
    await this.ensureBusiness(businessId);
    const [preview, candidates, invoices] = await Promise.all([
      this.schedule.preview(businessId, draft),
      this.schedule.keepCandidates(businessId),
      this.prisma.subscriptionInvoice.findMany({ where: { chainId: businessId }, include: { lines: true }, orderBy: { createdAt: 'desc' }, take: 12 }),
    ]);
    return { preview, candidates, invoices };
  }

  private async ensureBusiness(id: string) {
    const exists = await this.prisma.restaurantChain.count({ where: { id, deletedAt: null } });
    if (!exists) throw new NotFoundException('Business not found');
  }

  async renewSubscription(businessId: string, dto: RenewSubscriptionDto, adminUserId: string) {
    const subscription = await this.getSubscription(businessId);
    const pendingCheckout = await this.prisma.subscriptionCheckout.findFirst({ where: { chainId: businessId, status: 'PENDING' }, select: { id: true } });
    if (pendingCheckout) throw new ConflictException('A PayOS payment is still pending; reconcile or cancel it before manual renewal');
    const scheduledPlan = subscription.nextPlanId ? await this.getActivePlan(subscription.nextPlanId) : null;
    if (subscription.plan.code === 'TRIAL') {
      throw new ConflictException('The 14-day trial cannot be renewed');
    }
    const baseDate = subscription.expiresAt > new Date() ? subscription.expiresAt : new Date();
    if (subscription.pendingStartsAt) throw new ConflictException('Upcoming period has already been paid');
    const early = baseDate > new Date();
    const extraBranches = subscription.nextExtraBranches ?? (scheduledPlan && scheduledPlan.id !== subscription.planId ? 0 : subscription.activeExtraBranches);
    const accountPacks = subscription.nextAccountPacks ?? subscription.activeAccountPacks;
    const periodPlan = await this.prisma.servicePlan.findUniqueOrThrow({ where: { id: scheduledPlan?.id ?? subscription.planId } });
    await this.prisma.$transaction(async (transaction) => {
      await transaction.subscriptionInvoice.updateMany({ where: { chainId: businessId, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      await transaction.businessSubscription.update({
        where: { id: subscription.id },
        data: {
          expiresAt: this.addMonths(baseDate, dto.months),
          nextPlanId: null,
          nextExtraBranches: null,
          nextAccountPacks: null,
          ...(early ? {
            pendingPlanId: scheduledPlan?.id ?? subscription.planId,
            pendingMonthlyPrice: scheduledPlan?.monthlyPrice ?? subscription.monthlyPrice,
            pendingExtraBranches: extraBranches,
            pendingAccountPacks: accountPacks,
            pendingStartsAt: baseDate,
          } : {
            planId: scheduledPlan?.id ?? subscription.planId,
            monthlyPrice: scheduledPlan?.monthlyPrice ?? subscription.monthlyPrice,
            activeExtraBranches: extraBranches,
            activeAccountPacks: accountPacks,
            startsAt: baseDate,
          }),
        },
      });
      const period = await this.schedule.recordPeriod(transaction, {
        subscriptionId: subscription.id, chainId: businessId, plan: periodPlan, selection: { extraBranches, accountPacks },
        monthlyPrice: Math.round(Number(periodPlan.monthlyPrice)), extraBranchPrice: periodPlan.extraBranchPrice, accountPackPrice: periodPlan.extraAccountPackPrice,
        startsAt: baseDate, endsAt: this.addMonths(baseDate, dto.months), invoiceId: null, source: 'MANUAL_ADMIN',
        keepBranchIds: Array.isArray(subscription.nextKeepBranchIds) ? (subscription.nextKeepBranchIds as string[]) : null,
        keepAccountIds: Array.isArray(subscription.nextKeepAccountIds) ? (subscription.nextKeepAccountIds as string[]) : null,
      });
      await transaction.businessSubscription.update({ where: { id: subscription.id }, data: { nextKeepBranchIds: Prisma.DbNull, nextKeepAccountIds: Prisma.DbNull, nextRegisteredByRole: null, nextRegisteredAt: null } });
      if (!early) {
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'quota:' + businessId}))`;
        await this.schedule.applyPeriodStart(transaction, period);
      }
      await transaction.businessSubscriptionEvent.create({
        data: {
          subscriptionId: subscription.id,
          type: SubscriptionEventType.RENEWED,
          fromPlanId: subscription.planId,
          toPlanId: subscription.nextPlanId ?? subscription.planId,
          effectiveAt: baseDate,
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

  /** Same counting and limits as the Brand Manager screen and every quota check (subscription-usage.ts). */
  private async getBusinessUsageCounts(chainId: string) {
    const [usage, limits] = await Promise.all([countUsage(this.prisma, chainId), effectiveLimits(this.prisma, chainId)]);
    return {
      branchCount: usage.branches,
      accountCount: usage.accounts,
      tableCount: usage.tables,
      ownerCount: usage.owners,
      pendingInvitationCount: usage.pendingInvitations,
      branchLimit: limits?.branchLimit ?? null,
      accountLimit: limits?.accountLimit ?? null,
      activeExtraBranches: limits?.extraBranches ?? 0,
      activeAccountPacks: limits?.accountPacks ?? 0,
      limitsPeriodEndsAt: limits?.periodEndsAt ?? null,
    };
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
