import {
  BadRequestException,
  ConflictException,
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
    select: { id: true, email: true, phone: true, status: true, role: { select: { code: true } } },
  },
} satisfies Prisma.EmployeeSelect;

@Injectable()
export class ManagerStaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BranchAccessService,
    private readonly passwords: PasswordService,
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
    return { items, total, page: query.page, limit: query.limit };
  }

  async get(user: AuthenticatedUser, id: string) {
    const { branchId } = await this.scope(user);
    return this.target(this.prisma, branchId, id);
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
    if (!staffRoles.includes(dto.role))
      throw new BadRequestException('Only CASHIER and BARISTA can be created');
    const passwordHash = await this.passwords.hash(dto.password);
    return this.mutate(async (tx) => {
      const branch = await tx.branch.findUniqueOrThrow({
        where: { id: branchId },
        select: { chainId: true },
      });
      // Serialize manager hires across every branch of the same chain.
      await tx.$queryRaw`SELECT id FROM restaurant_chains WHERE id = ${branch.chainId}::uuid FOR UPDATE`;
      const subscription = await tx.businessSubscription.findFirst({
        where: { chainId: branch.chainId, status: 'ACTIVE', expiresAt: { gt: new Date() } },
        select: { plan: { select: { maxAccounts: true } } },
      });
      if (!subscription) throw new ConflictException('Subscription is not active');
      const employees = await tx.employee.count({
        where: { branch: { chainId: branch.chainId }, deletedAt: null, user: { deletedAt: null } },
      });
      const owners = await tx.ownerChainAssignment.count({
        where: { chainId: branch.chainId, owner: { deletedAt: null, user: { deletedAt: null } } },
      });
      if (employees + owners >= subscription.plan.maxAccounts) {
        throw new ConflictException({
          statusCode: 409,
          error: 'PLAN_LIMIT_REACHED',
          message: 'Đã hết hạn mức tài khoản. Liên hệ Owner để nâng gói.',
        });
      }
      const role = await tx.role.findUnique({ where: { code: dto.role }, select: { id: true } });
      if (!role) throw new ConflictException('Staff role is not configured; run the seed');
      const created = await tx.employee.create({
        data: {
          branch: { connect: { id: branchId } },
          employeeCode: dto.employeeCode.trim().toUpperCase(),
          firstName: dto.firstName.trim(),
          lastName: dto.lastName.trim(),
          jobTitle: dto.jobTitle?.trim(),
          dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
          hireDate: dto.hireDate ? new Date(dto.hireDate) : undefined,
          user: {
            create: {
              email: dto.email.trim().toLowerCase(),
              phone: dto.phone?.trim(),
              passwordHash,
              roleId: role.id,
              status: UserStatus.ACTIVE,
            },
          },
        },
        select: staffSelect,
      });
      await writeBranchAudit(tx, user, {
        action: 'STAFF_CREATED',
        entityType: 'EMPLOYEE',
        entityId: created.id,
        after: this.snapshot(created),
      });
      return created;
    });
  }

  async update(user: AuthenticatedUser, id: string, dto: ManagerUpdateStaffDto) {
    const { branchId } = await this.scope(user, true);
    if (!Object.values(dto).some((value) => value !== undefined))
      throw new BadRequestException('Provide at least one field');
    if (Object.values(dto).some((value) => value === null))
      throw new BadRequestException('Null fields are not supported');
    if (dto.role && !staffRoles.includes(dto.role))
      throw new BadRequestException('Only CASHIER and BARISTA roles are allowed');
    return this.mutate(async (tx) => {
      const old = await this.target(tx, branchId, id);
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
              phone: dto.phone?.trim(),
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
      return updated;
    });
  }

  async status(user: AuthenticatedUser, id: string, dto: ManagerStaffStatusDto) {
    const { branchId } = await this.scope(user, true);
    return this.mutate(async (tx) => {
      const old = await this.target(tx, branchId, id);
      await tx.user.update({ where: { id: old.user.id }, data: { status: dto.status } });
      if (dto.status !== UserStatus.ACTIVE) await this.revoke(tx, old.user.id);
      await writeBranchAudit(tx, user, {
        action: 'STAFF_STATUS_CHANGED',
        entityType: 'EMPLOYEE',
        entityId: id,
        reason: dto.reason,
        before: { status: old.user.status },
        after: { status: dto.status },
      });
      return this.target(tx, branchId, id);
    });
  }

  async resetPassword(user: AuthenticatedUser, id: string, dto: ManagerResetPasswordDto) {
    const { branchId } = await this.scope(user, true);
    const passwordHash = await this.passwords.hash(dto.password);
    return this.mutate(async (tx) => {
      const staff = await this.target(tx, branchId, id);
      await tx.user.update({ where: { id: staff.user.id }, data: { passwordHash } });
      await this.revoke(tx, staff.user.id);
      await tx.passwordSetupToken.updateMany({
        where: { userId: staff.user.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      await writeBranchAudit(tx, user, {
        action: 'STAFF_PASSWORD_RESET',
        entityType: 'EMPLOYEE',
        entityId: id,
        reason: dto.reason,
      });
      return { message: 'Password reset; all sessions revoked', employeeId: id };
    });
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
