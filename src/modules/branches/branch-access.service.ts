import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  BusinessSubscriptionStatus,
  RestaurantChainStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AppRole } from '../auth/app-role.enum.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';

@Injectable()
export class BranchAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async getAccessibleBranchIds(user: AuthenticatedUser): Promise<string[] | null> {
    if (user.role === AppRole.ADMIN) {
      throw new ForbiddenException('Platform ADMIN cannot access restaurant operations');
    }

    if (user.role === AppRole.OWNER) {
      if (!user.ownerId) {
        throw new ForbiddenException('The owner profile is missing');
      }
      const assignments = await this.prisma.ownerChainAssignment.findMany({
        where: {
          ownerId: user.ownerId,
          chain: {
            deletedAt: null,
            status: RestaurantChainStatus.ACTIVE,
          },
        },
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
    const activeBranch = await this.prisma.branch.count({
      where: {
        id: user.branchId,
        deletedAt: null,
        chain: {
          deletedAt: null,
          status: RestaurantChainStatus.ACTIVE,
        },
      },
    });
    if (activeBranch === 0) {
      throw new ForbiddenException('The assigned branch is not active');
    }
    return [user.branchId];
  }

  async assertSubscriptionAllowsWrite(branchId: string): Promise<void> {
    const activeSubscription = await this.prisma.branch.count({
      where: {
        id: branchId,
        deletedAt: null,
        chain: {
          deletedAt: null,
          status: RestaurantChainStatus.ACTIVE,
          subscription: {
            status: BusinessSubscriptionStatus.ACTIVE,
            expiresAt: { gt: new Date() },
          },
        },
      },
    });
    if (!activeSubscription) {
      throw new ForbiddenException(
        'The business subscription is read-only; renew it before making this change',
      );
    }
  }

  async assertCanAccessBranch(user: AuthenticatedUser, branchId: string): Promise<void> {
    const accessibleBranchIds = await this.getAccessibleBranchIds(user);
    if (accessibleBranchIds !== null && !accessibleBranchIds.includes(branchId)) {
      throw new ForbiddenException('You can only access a branch within your assigned scope');
    }
  }

  async assertCanManageBranch(user: AuthenticatedUser, branchId: string): Promise<void> {
    if (user.role !== AppRole.OWNER && user.role !== AppRole.MANAGER) {
      throw new ForbiddenException('Only OWNER or MANAGER can manage this branch');
    }
    await this.assertCanAccessBranch(user, branchId);
  }

  async assertCanManageChain(user: AuthenticatedUser, chainId: string): Promise<void> {
    if (user.role !== AppRole.OWNER || !user.ownerId) {
      throw new ForbiddenException('Only an assigned OWNER can manage this chain');
    }
    await this.assertCanAccessChain(user, chainId);
    const writableChain = await this.prisma.restaurantChain.count({
      where: {
        id: chainId,
        deletedAt: null,
        status: RestaurantChainStatus.ACTIVE,
        subscription: {
          status: BusinessSubscriptionStatus.ACTIVE,
          expiresAt: { gt: new Date() },
        },
      },
    });
    if (!writableChain) {
      throw new ForbiddenException(
        'The business subscription is read-only; renew it before making this change',
      );
    }
  }

  async assertCanAccessChain(user: AuthenticatedUser, chainId: string): Promise<void> {
    if (user.role !== AppRole.OWNER || !user.ownerId) {
      throw new ForbiddenException('Only an assigned OWNER can access this chain');
    }
    const assignmentCount = await this.prisma.ownerChainAssignment.count({
      where: {
        ownerId: user.ownerId,
        chainId,
        chain: { deletedAt: null, status: RestaurantChainStatus.ACTIVE },
      },
    });
    if (!assignmentCount) {
      throw new ForbiddenException('OWNER can only access an assigned restaurant chain');
    }
  }

  async assertCanReadChain(user: AuthenticatedUser, chainId: string): Promise<void> {
    if (user.role === AppRole.OWNER) {
      await this.assertCanAccessChain(user, chainId);
      return;
    }
    if (user.role !== AppRole.MANAGER || !user.branchId) {
      throw new ForbiddenException('Only an assigned OWNER or MANAGER can access this chain');
    }
    const assigned = await this.prisma.branch.count({
      where: {
        id: user.branchId,
        chainId,
        deletedAt: null,
        chain: { deletedAt: null, status: RestaurantChainStatus.ACTIVE },
      },
    });
    if (!assigned)
      throw new ForbiddenException('MANAGER can only access the assigned branch chain');
  }
}
