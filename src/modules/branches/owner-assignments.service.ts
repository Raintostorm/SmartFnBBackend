import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { AppRole } from '../auth/app-role.enum.js';

const ownedChainSelect = {
  id: true,
  code: true,
  name: true,
  status: true,
  timezone: true,
  currency: true,
} as const;

@Injectable()
export class OwnerAssignmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async getOwnerChains(ownerId: string) {
    const owner = await this.findOwner(ownerId);
    return {
      ownerId: owner.id,
      ownerCode: owner.ownerCode,
      chains: owner.chainAssignments.map(({ chain }) => chain),
    };
  }

  async replaceOwnerChains(ownerId: string, chainIds: string[], assignedById: string) {
    await this.findOwner(ownerId);
    const uniqueChainIds = [...new Set(chainIds)];

    if (uniqueChainIds.length > 0) {
      const existingChainCount = await this.prisma.restaurantChain.count({
        where: { id: { in: uniqueChainIds }, deletedAt: null },
      });
      if (existingChainCount !== uniqueChainIds.length) {
        throw new BadRequestException('One or more restaurant chains do not exist');
      }
    }

    await this.prisma.$transaction(async (transaction) => {
      await transaction.ownerChainAssignment.deleteMany({ where: { ownerId } });
      if (uniqueChainIds.length > 0) {
        await transaction.ownerChainAssignment.createMany({
          data: uniqueChainIds.map((chainId) => ({ ownerId, chainId, assignedById })),
        });
      }
    });

    return this.getOwnerChains(ownerId);
  }

  async listChainOwners(chainId: string) {
    const chainExists = await this.prisma.restaurantChain.count({
      where: { id: chainId, deletedAt: null },
    });
    if (chainExists === 0) {
      throw new NotFoundException('Restaurant chain not found');
    }

    return this.prisma.owner.findMany({
      where: {
        deletedAt: null,
        user: { deletedAt: null, role: { code: AppRole.OWNER } },
        chainAssignments: { some: { chainId } },
      },
      select: {
        id: true,
        ownerCode: true,
        firstName: true,
        lastName: true,
        user: { select: { id: true, email: true, phone: true, status: true } },
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });
  }

  private async findOwner(ownerId: string) {
    const owner = await this.prisma.owner.findFirst({
      where: {
        id: ownerId,
        deletedAt: null,
        user: { deletedAt: null, role: { code: AppRole.OWNER } },
      },
      select: {
        id: true,
        ownerCode: true,
        chainAssignments: {
          where: { chain: { deletedAt: null } },
          select: { chain: { select: ownedChainSelect } },
          orderBy: { assignedAt: 'asc' },
        },
      },
    });
    if (!owner) {
      throw new NotFoundException('Owner profile not found');
    }
    return owner;
  }
}
