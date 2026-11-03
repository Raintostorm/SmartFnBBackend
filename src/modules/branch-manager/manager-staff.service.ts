import { StaffAccountsService } from '../employees/staff-accounts.service.js';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AppRole } from '../auth/app-role.enum.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { PasswordService } from '../auth/password.service.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import type {
  ManagerCreateStaffDto,
  ManagerUpdateStaffDto,
  ManagerStaffQueryDto,
  ManagerStaffStatusDto,
  ManagerResetPasswordDto,
} from './manager.dto.js';
import { managerActor, writeBranchAudit } from './manager-scope.js';
import { EmailOutboxService } from '../email/email-outbox.service.js';

const staffRoles = [AppRole.CASHIER, AppRole.BARISTA];
const staffSelect = {
  id: true,
  branchId: true,
  employeeCode: true,
  firstName: true,
  lastName: true,
  jobTitle: true,
  dateOfBirth: true,
  hireDate: true,
  status: true,
  user: {
    select: {
      id: true,
      email: true,
      phone: true,
      status: true,
      lastLoginAt: true,
      staffInvitationState: true,
      role: { select: { code: true } },
      passwordSetupTokens: {
        where: { usedAt: null },
        orderBy: { createdAt: 'desc' as const },
        take: 1,
        select: { expiresAt: true },
      },
    },
  },
} satisfies Prisma.EmployeeSelect;

@Injectable()
export class ManagerStaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BranchAccessService,
    private readonly passwords: PasswordService,
    private readonly emails: EmailOutboxService,
    private readonly accounts: StaffAccountsService,
  ) {}

  private async scope(user: AuthenticatedUser, write = false) {
    const actor = managerActor(user);
    await this.access.assertCanAccessBranch(user, actor.branchId);
    if (write) await this.access.assertSubscriptionAllowsWrite(actor.branchId);
    return actor;
  }

  private staffWhere(branchId: string): Prisma.EmployeeWhereInput {
    return {
      branchId,
      deletedAt: null,
      user: { deletedAt: null, role: { code: { in: staffRoles } } },
    };
  }

  async list(user: AuthenticatedUser, query: ManagerStaffQueryDto) {
    const { branchId } = await this.scope(user);
    const search = query.search?.trim();
    const where: Prisma.EmployeeWhereInput = {
      ...this.staffWhere(branchId),
      user: {
        deletedAt: null,
        status: query.status,
        role: { code: query.role ?? { in: staffRoles } },
      },
      ...(search
        ? {
            OR: [
              { employeeCode: { contains: search, mode: 'insensitive' } },
              { firstName: { contains: search, mode: 'insensitive' } },
              { lastName: { contains: search, mode: 'insensitive' } },
              { user: { email: { contains: search, mode: 'insensitive' } } },
              { user: { phone: { contains: search } } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.employee.findMany({
        where,
        select: staffSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.employee.count({ where }),
    ]);
    return {
      items: items.map((item) => this.response(item)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async get(user: AuthenticatedUser, id: string) {
    const { branchId } = await this.scope(user);
    return this.response(await this.target(this.prisma, branchId, id));
  }

  private async target(tx: Prisma.TransactionClient, branchId: string, id: string) {
    const employee = await tx.employee.findFirst({
      where: { ...this.staffWhere(branchId), id },
      select: staffSelect,
    });
    if (!employee) throw new NotFoundException('Cashier/Barista not found in your branch');
    return employee;
  }

  async create(user: AuthenticatedUser, dto: ManagerCreateStaffDto) {
    const { branchId } = await this.scope(user, true);
    const result = await this.accounts.invite(user, { ...dto, branchId });
    return {
      ...result.account,
      invitationExpiresAt: result.invitationExpiresAt,
      emailStatus: result.emailStatus,
    };
  }

  async update(user: AuthenticatedUser, id: string, dto: ManagerUpdateStaffDto) {
    const { branchId } = await this.scope(user, true);
    if (!Object.values(dto).some((value) => value !== undefined))
      throw new BadRequestException('Provide at least one field');
    if (Object.entries(dto).some(([field, value]) => value === null && field !== 'phone'))
      throw new BadRequestException('Only phone can be cleared with null');
    if (dto.role && !staffRoles.includes(dto.role))
      throw new BadRequestException('Only CASHIER and BARISTA roles are allowed');
    return this.mutate(async (tx) => {
      const old = await this.target(tx, branchId, id);
      if (dto.email && dto.email.trim().toLowerCase() !== old.user.email) {
        throw new ConflictException(
          'Account email cannot be changed; cancel and invite the correct email',
        );
      }
      const role = dto.role
        ? await tx.role.findUniqueOrThrow({ where: { code: dto.role }, select: { id: true } })
        : undefined;
      const updated = await tx.employee.update({
        where: { id },
        data: {
          employeeCode: dto.employeeCode?.trim().toUpperCase(),
          firstName: dto.firstName?.trim(),
          lastName: dto.lastName?.trim(),
          jobTitle: dto.jobTitle?.trim(),
          dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
          hireDate: dto.hireDate ? new Date(dto.hireDate) : undefined,
          user: {
            update: {
              email: dto.email?.trim().toLowerCase(),
              phone: dto.phone === null ? null : dto.phone?.trim(),
              roleId: role?.id,
            },
          },
        },
        select: staffSelect,
      });
      if (dto.role || dto.email) await this.revoke(tx, old.user.id);
      await writeBranchAudit(tx, user, {
        action: 'STAFF_UPDATED',
        entityType: 'EMPLOYEE',
        entityId: id,
        before: this.snapshot(old),
        after: this.snapshot(updated),
      });
      return this.response(updated);
    });
  }

  async status(user: AuthenticatedUser, id: string, dto: ManagerStaffStatusDto) {
    return this.accounts.status(user, id, dto.status, dto.reason);
  }

  async cancelInvitation(user: AuthenticatedUser, id: string, reason: string) {
    return this.accounts.cancel(user, id, reason);
  }

  async resetPassword(user: AuthenticatedUser, id: string, dto: ManagerResetPasswordDto) {
    return this.accounts.sendSetup(user, id, dto.reason);
  }

  async resendInvitation(user: AuthenticatedUser, id: string, reason: string) {
    return this.accounts.sendSetup(user, id, reason, true);
  }

  private snapshot(
    staff: Prisma.EmployeeGetPayload<{ select: typeof staffSelect }>,
  ): Prisma.InputJsonValue {
    return {
      employeeCode: staff.employeeCode,
      firstName: staff.firstName,
      lastName: staff.lastName,
      jobTitle: staff.jobTitle,
      dateOfBirth: staff.dateOfBirth?.toISOString() ?? null,
      hireDate: staff.hireDate.toISOString(),
      email: staff.user.email,
      phone: staff.user.phone,
      role: staff.user.role.code,
      status: staff.user.status,
    };
  }

  private response(staff: Prisma.EmployeeGetPayload<{ select: typeof staffSelect }>) {
    const { passwordSetupTokens, ...user } = staff.user;
    const invitationExpiresAt = passwordSetupTokens?.[0]?.expiresAt ?? null;
    const invitationStatus =
      user.staffInvitationState === 'CANCELLED'
        ? 'CANCELLED'
        : user.status === UserStatus.ACTIVE
          ? 'ACTIVE'
          : user.status === UserStatus.SUSPENDED
            ? 'SUSPENDED'
            : invitationExpiresAt && invitationExpiresAt > new Date()
              ? 'INVITED'
              : invitationExpiresAt
                ? 'INVITATION_EXPIRED'
                : 'DEACTIVATED';
    return { ...staff, user, invitationStatus, invitationExpiresAt };
  }

  private revoke(tx: Prisma.TransactionClient, userId: string) {
    return tx.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async mutate<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ConflictException('Email, phone or employee code already exists');
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034')
        throw new ConflictException('Concurrent update; reload and retry');
      throw error;
    }
  }
}
