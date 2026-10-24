import { StaffAccountsService } from './staff-accounts.service.js';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AppRole } from '../auth/app-role.enum.js';
import { PasswordService } from '../auth/password.service.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import type {
  InviteManagerDto,
  ListEmployeesQueryDto,
  SetDirectStaffPasswordDto,
  TransferEmployeeBranchDto,
  UpdateEmployeeAccountStatusDto,
} from './dto/employee.dto.js';

const employeeSelect = {
  id: true,
  employeeCode: true,
  firstName: true,
  lastName: true,
  jobTitle: true,
  hireDate: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  branch: { select: { id: true, code: true, name: true, city: true, chainId: true } },
  user: {
    select: {
      id: true,
      email: true,
      phone: true,
      status: true,
      lastLoginAt: true,
      staffInvitationState: true,
      passwordSetupTokens: {
        where: { usedAt: null },
        orderBy: { createdAt: 'desc' as const },
        take: 1,
        select: { expiresAt: true },
      },
      role: { select: { code: true, name: true } },
    },
  },
} satisfies Prisma.EmployeeSelect;

/**
 * Staff administration from the Owner side. New Manager, Cashier and Barista
 * accounts use shared email invitation onboarding.
 */
@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branchAccess: BranchAccessService,
    private readonly passwords: PasswordService,
    private readonly accounts: StaffAccountsService,
  ) {}

  async setDirectPassword(
    user: AuthenticatedUser,
    employeeId: string,
    dto: SetDirectStaffPasswordDto,
  ) {
    const employee = await this.getEmployee(user, employeeId);
    if (
      ![AppRole.MANAGER, AppRole.CASHIER, AppRole.BARISTA].includes(
        employee.user.role.code as AppRole,
      )
    ) {
      throw new ForbiddenException('Only Manager, Cashier and Barista passwords can be set here');
    }
    if (employee.user.email.includes('@')) {
      throw new ForbiddenException('Email-invited accounts use email password setup');
    }
    const passwordHash = await this.passwords.hash(dto.password);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: employee.user.id }, data: { passwordHash } });
      await tx.authSession.updateMany({
        where: { userId: employee.user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    return { message: 'Password updated; active sessions revoked' };
  }

  async inviteManager(user: AuthenticatedUser, dto: InviteManagerDto) {
    const [firstName, ...rest] = dto.name.trim().split(/\s+/);
    return this.accounts.invite(user, {
      ...dto,
      role: AppRole.MANAGER,
      firstName,
      lastName: rest.join(' '),
    });
  }

  /** Read-only roster across the Owner's branches, including waiter and kitchen staff. */
  async listEmployees(user: AuthenticatedUser, query: ListEmployeesQueryDto) {
    const branchIds = await this.getScopedBranchIds(user, query.branchId);
    const search = query.search;

    const where: Prisma.EmployeeWhereInput = {
      deletedAt: null,
      branchId: { in: branchIds },
      user: {
        deletedAt: null,
        status: query.status,
        ...(query.role ? { role: { code: query.role } } : {}),
      },
      ...(search
        ? {
            OR: [
              { firstName: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { lastName: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { employeeCode: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { user: { email: { contains: search, mode: Prisma.QueryMode.insensitive } } },
            ],
          }
        : {}),
    };

    const [total, items] = await Promise.all([
      this.prisma.employee.count({ where }),
      this.prisma.employee.findMany({
        where,
        select: employeeSelect,
        orderBy: [{ branch: { name: 'asc' } }, { lastName: 'asc' }, { firstName: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    return {
      items,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  async getEmployee(user: AuthenticatedUser, employeeId: string) {
    const branchIds = await this.getScopedBranchIds(user);
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, deletedAt: null, branchId: { in: branchIds } },
      select: employeeSelect,
    });
    if (!employee) {
      throw new NotFoundException('Employee not found in your scope');
    }
    return employee;
  }

  async updateManagerAccountStatus(
    user: AuthenticatedUser,
    employeeId: string,
    dto: UpdateEmployeeAccountStatusDto,
  ) {
    await this.getManagerOrFail(user, employeeId);
    return this.accounts.status(user, employeeId, dto.status, dto.reason);
  }

  async resetManagerPassword(
    user: AuthenticatedUser,
    employeeId: string,
    reason = 'Owner requested password setup',
  ) {
    await this.getManagerOrFail(user, employeeId);
    return this.accounts.sendSetup(user, employeeId, reason);
  }

  /** Moves a manager to another branch of the same chain and ends their sessions. */
  async transferManagerBranch(
    user: AuthenticatedUser,
    employeeId: string,
    dto: TransferEmployeeBranchDto,
  ) {
    const manager = await this.getManagerOrFail(user, employeeId);
    if (manager.branch.id === dto.branchId) {
      return manager;
    }

    const targetBranch = await this.prisma.branch.findFirst({
      where: { id: dto.branchId, deletedAt: null, chainId: manager.branch.chainId },
      select: { id: true, name: true },
    });
    if (!targetBranch) {
      throw new NotFoundException('Target branch not found in the same restaurant chain');
    }
    await this.branchAccess.assertCanManageBranch(user, targetBranch.id);

    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.employee.update({
        where: { id: manager.id },
        data: { branchId: targetBranch.id },
        select: employeeSelect,
      });
      // The access token carries the old branch, so the manager signs in again.
      await transaction.authSession.updateMany({
        where: { userId: manager.user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return updated;
    });
  }

  // --- Helpers --------------------------------------------------------------

  private async getScopedBranchIds(user: AuthenticatedUser, branchId?: string): Promise<string[]> {
    if (user.role !== AppRole.OWNER) {
      throw new ForbiddenException('Only OWNER can administer staff accounts');
    }
    const accessibleBranchIds = await this.branchAccess.getAccessibleBranchIds(user);
    // getAccessibleBranchIds returns null only for roles with unrestricted scope,
    // which OWNER is not, so an empty list means "no active chain".
    const branchIds = accessibleBranchIds ?? [];

    if (!branchId) {
      return branchIds;
    }
    if (!branchIds.includes(branchId)) {
      throw new ForbiddenException('You can only access a branch within your assigned scope');
    }
    return [branchId];
  }

  private async getManagerOrFail(user: AuthenticatedUser, employeeId: string) {
    const employee = await this.getEmployee(user, employeeId);
    if (
      ![AppRole.MANAGER, AppRole.CASHIER, AppRole.BARISTA].includes(
        employee.user.role.code as AppRole,
      )
    ) {
      throw new ForbiddenException(
        'OWNER can only administer MANAGER, CASHIER and BARISTA accounts',
      );
    }
    return employee;
  }
}
