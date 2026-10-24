import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Prisma, UserStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AppRole } from '../auth/app-role.enum.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { PasswordService } from '../auth/password.service.js';
import { EmailOutboxService } from '../email/email-outbox.service.js';

const roles: readonly string[] = [AppRole.MANAGER, AppRole.CASHIER, AppRole.BARISTA];
const ttl = 24 * 60 * 60 * 1000;
export const staffAccountSelect = {
  id: true,
  branchId: true,
  employeeCode: true,
  firstName: true,
  lastName: true,
  user: {
    select: {
      id: true,
      email: true,
      status: true,
      staffInvitationState: true,
      role: { select: { code: true } },
    },
  },
} satisfies Prisma.EmployeeSelect;
type Staff = Prisma.EmployeeGetPayload<{ select: typeof staffAccountSelect }>;
type InviteInput = {
  branchId: string;
  role: string;
  email: string;
  firstName: string;
  lastName: string;
  employeeCode?: string;
  phone?: string;
  jobTitle?: string;
  dateOfBirth?: string;
  hireDate?: string;
};

/** Shared policy for Owner and Manager: all new accounts require email activation. */
@Injectable()
export class StaffAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly emails: EmailOutboxService,
  ) {}

  private assertRole(actor: AuthenticatedUser, role: string) {
    if (
      !roles.includes(role) ||
      ![AppRole.OWNER, AppRole.MANAGER].includes(actor.role) ||
      (actor.role === AppRole.MANAGER && role === AppRole.MANAGER)
    ) {
      throw new ForbiddenException('Not allowed to manage this staff role');
    }
  }

  private async branch(tx: Prisma.TransactionClient, actor: AuthenticatedUser, branchId: string) {
    if (![AppRole.OWNER, AppRole.MANAGER].includes(actor.role)) throw new ForbiddenException();
    const branch = await tx.branch.findFirst({
      where: { id: branchId, deletedAt: null, status: 'ACTIVE' },
      select: { id: true, name: true, chainId: true },
    });
    if (!branch) throw new NotFoundException('Active branch not found');
    // Same lock for all hires in the chain: pending accounts count toward the quota.
    await tx.$queryRaw`SELECT id FROM restaurant_chains WHERE id = ${branch.chainId}::uuid FOR UPDATE`;
    const chain = await tx.restaurantChain.findFirst({
      where: { id: branch.chainId, deletedAt: null, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!chain) throw new ForbiddenException('Business is not active');
    if (actor.role === AppRole.OWNER) {
      if (
        !actor.ownerId ||
        !(await tx.ownerChainAssignment.count({
          where: {
            ownerId: actor.ownerId,
            chainId: branch.chainId,
            owner: { deletedAt: null, user: { status: 'ACTIVE', deletedAt: null } },
          },
        }))
      )
        throw new ForbiddenException('Branch is outside your business');
    } else if (
      !actor.employeeId ||
      actor.branchId !== branchId ||
      !(await tx.employee.count({
        where: {
          id: actor.employeeId,
          userId: actor.id,
          branchId,
          deletedAt: null,
          status: 'ACTIVE',
          user: { status: 'ACTIVE', deletedAt: null, role: { code: AppRole.MANAGER } },
        },
      }))
    )
      throw new ForbiddenException('Manager may only manage their assigned branch');
    const subscription = await tx.businessSubscription.findFirst({
      where: {
        chainId: branch.chainId,
        status: 'ACTIVE',
        expiresAt: { gt: new Date() },
      },
      select: { plan: { select: { maxAccounts: true } } },
    });
    if (!subscription) throw new ForbiddenException('Business subscription is not active');
    return { ...branch, maxAccounts: subscription.plan.maxAccounts };
  }

  private async target(tx: Prisma.TransactionClient, actor: AuthenticatedUser, employeeId: string) {
    const initial = await tx.employee.findFirst({
      where: { id: employeeId, deletedAt: null, user: { deletedAt: null } },
      select: staffAccountSelect,
    });
    if (!initial) throw new NotFoundException('Staff account not found');
    this.assertRole(actor, initial.user.role.code);
    const branch = await this.branch(tx, actor, initial.branchId);
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${initial.user.id}::uuid FOR UPDATE`;
    const staff = await tx.employee.findFirst({
      where: { id: employeeId, branchId: branch.id, deletedAt: null, user: { deletedAt: null } },
      select: staffAccountSelect,
    });
    if (!staff) throw new ConflictException('Staff scope changed; retry');
    this.assertRole(actor, staff.user.role.code);
    return { staff, branch };
  }

  private audit(
    tx: Prisma.TransactionClient,
    actor: AuthenticatedUser,
    staff: Staff,
    action: string,
    reason?: string,
    after?: Prisma.InputJsonValue,
  ) {
    return tx.branchAuditLog.create({
      data: {
        branchId: staff.branchId,
        actorUserId: actor.id,
        actorEmployeeId: actor.employeeId ?? null,
        actorRole: actor.role,
        entityType: 'EMPLOYEE',
        entityId: staff.id,
        action,
        reason,
        after,
      },
    });
  }

  private async tokenEmail(
    tx: Prisma.TransactionClient,
    actor: AuthenticatedUser,
    staff: Staff,
    branchName: string,
    token: string,
    expiresAt: Date,
  ) {
    await tx.passwordSetupToken.updateMany({
      where: { userId: staff.user.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    await tx.passwordSetupToken.create({
      data: {
        userId: staff.user.id,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt,
      },
    });
    return tx.emailOutbox.create({
      data: {
        recipient: staff.user.email,
        subject: 'Thiết lập mật khẩu nhân viên Smart F&B',
        template: 'STAFF_ACCOUNT_CREATED',
        payload: {
          employeeName: `${staff.firstName} ${staff.lastName}`.trim(),
          branchName,
          role: staff.user.role.code,
          setupToken: token,
          setupPath: '/setup-password',
          expiresAt: expiresAt.toISOString(),
          requestedByUserId: actor.id,
        },
      },
      select: { id: true },
    });
  }

  private async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e) {
        if (e.code === 'P2002')
          throw new ConflictException('Email, phone or employee code already exists');
        if (e.code === 'P2034') throw new ConflictException('Concurrent update; retry');
      }
      throw e;
    }
  }

  async invite(actor: AuthenticatedUser, dto: InviteInput) {
    this.assertRole(actor, dto.role);
    const token = randomBytes(32).toString('base64url');
    const passwordHash = await this.passwords.hash(randomBytes(32).toString('base64url'));
    const expiresAt = new Date(Date.now() + ttl);
    const result = await this.transaction(async (tx) => {
      const branch = await this.branch(tx, actor, dto.branchId);
      const employees = await tx.employee.count({
        where: { branch: { chainId: branch.chainId }, deletedAt: null, user: { deletedAt: null } },
      });
      const owners = await tx.ownerChainAssignment.count({
        where: { chainId: branch.chainId, owner: { deletedAt: null, user: { deletedAt: null } } },
      });
      if (employees + owners >= branch.maxAccounts)
        throw new ConflictException({
          statusCode: 409,
          error: 'PLAN_LIMIT_REACHED',
          message: 'Account quota reached; contact Owner to upgrade',
        });
      const role = await tx.role.findUniqueOrThrow({
        where: { code: dto.role },
        select: { id: true },
      });
      const account = await tx.employee.create({
        data: {
          branch: { connect: { id: branch.id } },
          employeeCode:
            dto.employeeCode?.trim().toUpperCase() ??
            `EMP-${randomUUID().replaceAll('-', '').slice(0, 16)}`,
          firstName: dto.firstName.trim(),
          lastName: dto.lastName.trim(),
          jobTitle: dto.jobTitle,
          dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
          hireDate: dto.hireDate ? new Date(dto.hireDate) : undefined,
          user: {
            create: {
              email: dto.email.trim().toLowerCase(),
              phone: dto.phone,
              passwordHash,
              roleId: role.id,
              status: UserStatus.INACTIVE,
              staffInvitationState: 'PENDING',
            },
          },
        },
        select: staffAccountSelect,
      });
      const email = await this.tokenEmail(tx, actor, account, branch.name, token, expiresAt);
      await this.audit(tx, actor, account, 'STAFF_INVITED', undefined, {
        role: dto.role,
        email: account.user.email,
      });
      return { account, emailId: email.id };
    });
    return {
      account: result.account,
      invitationExpiresAt: expiresAt,
      emailStatus: await this.emails.deliver(result.emailId),
    };
  }

  async sendSetup(
    actor: AuthenticatedUser,
    employeeId: string,
    reason: string,
    resendOnly = false,
  ) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttl);
    const result = await this.transaction(async (tx) => {
      const { staff, branch } = await this.target(tx, actor, employeeId);
      if (!staff.user.email.includes('@'))
        throw new ForbiddenException('Legacy username accounts do not have an email inbox');
      if (staff.user.status === 'SUSPENDED' || staff.user.staffInvitationState === 'CANCELLED')
        throw new ConflictException('Account is locked or invitation cancelled');
      if (resendOnly && staff.user.staffInvitationState !== 'PENDING')
        throw new ConflictException('Only pending invitations may be resent');
      if (staff.user.status !== 'ACTIVE' && staff.user.staffInvitationState !== 'PENDING')
        throw new ConflictException('Account must be unlocked before resetting password');
      const latest = await tx.passwordSetupToken.findFirst({
        where: { userId: staff.user.id },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (latest && Date.now() - latest.createdAt.getTime() < 60_000)
        throw new HttpException('Wait 60 seconds before requesting another email', 429);
      const email = await this.tokenEmail(tx, actor, staff, branch.name, token, expiresAt);
      await tx.authSession.updateMany({
        where: { userId: staff.user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit(
        tx,
        actor,
        staff,
        resendOnly ? 'STAFF_INVITATION_RESENT' : 'STAFF_PASSWORD_SETUP_SENT',
        reason,
      );
      return { emailId: email.id };
    });
    return { employeeId, expiresAt, emailStatus: await this.emails.deliver(result.emailId) };
  }

  async cancel(actor: AuthenticatedUser, employeeId: string, reason: string) {
    return this.transaction(async (tx) => {
      const { staff } = await this.target(tx, actor, employeeId);
      if (staff.user.staffInvitationState !== 'PENDING')
        throw new ConflictException('Only pending invitations can be cancelled');
      await tx.user.update({
        where: { id: staff.user.id },
        data: { status: 'INACTIVE', staffInvitationState: 'CANCELLED' },
      });
      await tx.passwordSetupToken.updateMany({
        where: { userId: staff.user.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.authSession.updateMany({
        where: { userId: staff.user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit(tx, actor, staff, 'STAFF_INVITATION_CANCELLED', reason);
      return { employeeId, invitationState: 'CANCELLED' };
    });
  }

  async status(actor: AuthenticatedUser, employeeId: string, status: UserStatus, reason: string) {
    return this.transaction(async (tx) => {
      const { staff } = await this.target(tx, actor, employeeId);
      if (
        staff.user.staffInvitationState === 'CANCELLED' ||
        (status === 'ACTIVE' && staff.user.staffInvitationState === 'PENDING')
      )
        throw new ConflictException('Invitation must be accepted before activation');
      await tx.user.update({ where: { id: staff.user.id }, data: { status } });
      if (status !== 'ACTIVE') {
        await tx.authSession.updateMany({
          where: { userId: staff.user.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await tx.passwordSetupToken.updateMany({
          where: { userId: staff.user.id, usedAt: null },
          data: { usedAt: new Date() },
        });
      }
      await this.audit(tx, actor, staff, 'STAFF_STATUS_CHANGED', reason, {
        before: staff.user.status,
        status,
      });
      return { employeeId, user: { id: staff.user.id, status } };
    });
  }
}
