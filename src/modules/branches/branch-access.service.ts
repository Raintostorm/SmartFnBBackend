import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { AppRole } from '../auth/app-role.enum.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';

@Injectable()
export class BranchAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async getAccessibleBranchIds(user: AuthenticatedUser): Promise<string[] | null> {
    if (user.role === AppRole.ADMIN) {
      return null;
    }

    if (user.role === AppRole.OWNER) {
      if (!user.ownerId) {
        throw new ForbiddenException('The owner profile is missing');
      }
      const assignments = await this.prisma.ownerChainAssignment.findMany({
        where: { ownerId: user.ownerId },
        select: { chainId: true },
      });
      if (assignments.length === 0) {
        return [];
      }
      const branches = await this.prisma.branch.findMany({
        where: {
          chainId: { in: assignments.map(({ chainId }) => chainId) },
          deletedAt: null,
        },
        select: { id: true },
      });
      return branches.map(({ id }) => id);
    }

    if (!user.branchId) {
      throw new ForbiddenException('The current employee is not assigned to a branch');
    }
    return [user.branchId];
  }

  async assertCanAccessBranch(user: AuthenticatedUser, branchId: string): Promise<void> {
    const accessibleBranchIds = await this.getAccessibleBranchIds(user);
    if (accessibleBranchIds !== null && !accessibleBranchIds.includes(branchId)) {
      throw new ForbiddenException('You can only access a branch within your assigned scope');
    }
  }

  async assertCanManageBranch(user: AuthenticatedUser, branchId: string): Promise<void> {
    if (
      user.role !== AppRole.ADMIN &&
      user.role !== AppRole.OWNER &&
      user.role !== AppRole.MANAGER
    ) {
      throw new ForbiddenException('Only ADMIN, OWNER, or MANAGER can manage this branch');
    }
    await this.assertCanAccessBranch(user, branchId);
  }

  async assertCanManageChain(user: AuthenticatedUser, chainId: string): Promise<void> {
    if (user.role === AppRole.ADMIN) {
      return;
    }
    if (user.role !== AppRole.OWNER || !user.ownerId) {
      throw new ForbiddenException('Only ADMIN or an assigned OWNER can manage this chain');
    }
    const assignmentCount = await this.prisma.ownerChainAssignment.count({
      where: { ownerId: user.ownerId, chainId },
    });
    if (assignmentCount === 0) {
      throw new ForbiddenException('OWNER can only manage an assigned restaurant chain');
    }
  }
}
