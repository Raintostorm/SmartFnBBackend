import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import { Prisma, UserStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AppRole } from '../auth/app-role.enum.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import type {
  ListEmployeesQueryDto,
  TransferEmployeeBranchDto,
  UpdateEmployeeAccountStatusDto,
} from './dto/employee.dto.js';

const PASSWORD_SETUP_TTL_MS = 24 * 60 * 60 * 1000;

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
      role: { select: { code: true, name: true } },
    },
  },
} satisfies Prisma.EmployeeSelect;

/**
 * Staff administration from the Owner side. An Owner sees every employee in the
 * chains they are assigned to, but only acts on MANAGER accounts — waiter and
 * kitchen accounts belong to the Branch Manager.
 */
@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branchAccess: BranchAccessService,
  ) {}

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

  /** Locks or unlocks a manager account; locking revokes every live session. */
  async updateManagerAccountStatus(
    user: AuthenticatedUser,
    employeeId: string,
    dto: UpdateEmployeeAccountStatusDto,
  ) {
    const manager = await this.getManagerOrFail(user, employeeId);
    if (manager.user.id === user.id) {
      throw new ForbiddenException('You cannot change your own account status');
    }

    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.user.update({
        where: { id: manager.user.id },
        data: { status: dto.status },
        select: { id: true, email: true, status: true, updatedAt: true },
      });

      if (dto.status !== UserStatus.ACTIVE) {
        await transaction.authSession.updateMany({
          where: { userId: manager.user.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }

      return {
        employeeId: manager.id,
        employeeCode: manager.employeeCode,
        branch: manager.branch,
        user: updated,
      };
    });
  }

  /**
   * Issues a one-time password setup token for a manager and revokes their sessions.
   * The token is delivered through the email outbox, never in the response body.
   */
  async resetManagerPassword(user: AuthenticatedUser, employeeId: string) {
    const manager = await this.getManagerOrFail(user, employeeId);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + PASSWORD_SETUP_TTL_MS);
    const now = new Date();

    await this.prisma.$transaction(async (transaction) => {
      await transaction.passwordSetupToken.updateMany({
        where: { userId: manager.user.id, usedAt: null },
        data: { usedAt: now },
      });
      await transaction.passwordSetupToken.create({
        data: {
          userId: manager.user.id,
          tokenHash: createHash('sha256').update(token).digest('hex'),
          expiresAt,
        },
      });
      await transaction.authSession.updateMany({
        where: { userId: manager.user.id, revokedAt: null },
        data: { revokedAt: now },
      });
      await transaction.emailOutbox.create({
        data: {
          recipient: manager.user.email,
          subject: 'Đặt lại mật khẩu tài khoản Manager Smart F&B',
          template: 'MANAGER_PASSWORD_RESET',
          payload: {
            managerName: `${manager.firstName} ${manager.lastName}`,
            branchName: manager.branch.name,
            setupToken: token,
            setupPath: '/auth/setup-password',
            expiresAt: expiresAt.toISOString(),
            requestedByUserId: user.id,
          },
        },
      });
    });

    return {
      message: 'A password setup link has been sent to the manager',
      expiresAt,
    };
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
    if (employee.user.role.code !== AppRole.MANAGER) {
      throw new ForbiddenException(
        'OWNER can only administer MANAGER accounts; other staff accounts belong to the branch manager',
      );
    }
    return employee;
  }
}
