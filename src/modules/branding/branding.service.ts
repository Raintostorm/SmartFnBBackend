import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { AppRole } from '../auth/app-role.enum.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import type { UpdateBrandingDto } from './dto/branding.dto.js';

const DEFAULT_BRANDING = {
  primaryColor: '#0F172A',
  secondaryColor: '#FFFFFF',
  accentColor: '#22C55E',
} as const;

@Injectable()
export class BrandingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  async get(chainId: string, user: AuthenticatedUser) {
    await this.assertCanRead(chainId, user);
    const chain = await this.getChain(chainId);
    return (
      chain.branding ?? {
        chainId,
        displayName: chain.name,
        logoUrl: chain.logoUrl,
        ...DEFAULT_BRANDING,
      }
    );
  }

  async update(chainId: string, dto: UpdateBrandingDto, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    const chain = await this.getChain(chainId);
    return this.prisma.$transaction(async (tx) => {
      const branding = await tx.businessBranding.upsert({
        where: { chainId },
        create: {
          chainId,
          displayName: dto.displayName ?? chain.name,
          logoUrl: dto.logoUrl ?? chain.logoUrl,
          primaryColor: dto.primaryColor ?? DEFAULT_BRANDING.primaryColor,
          secondaryColor: dto.secondaryColor ?? DEFAULT_BRANDING.secondaryColor,
          accentColor: dto.accentColor ?? DEFAULT_BRANDING.accentColor,
        },
        update: dto,
      });
      if (dto.logoUrl !== undefined) {
        await tx.restaurantChain.update({ where: { id: chainId }, data: { logoUrl: dto.logoUrl } });
      }
      return branding;
    });
  }

  async reset(chainId: string, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    const chain = await this.getChain(chainId);
    return this.prisma.$transaction(async (tx) => {
      await tx.restaurantChain.update({ where: { id: chainId }, data: { logoUrl: null } });
      return tx.businessBranding.upsert({
        where: { chainId },
        create: { chainId, displayName: chain.name, ...DEFAULT_BRANDING },
        update: { displayName: chain.name, logoUrl: null, ...DEFAULT_BRANDING },
      });
    });
  }

  private async assertCanRead(chainId: string, user: AuthenticatedUser) {
    if (user.role === AppRole.OWNER) {
      await this.branchAccess.assertCanManageChain(user, chainId);
      return;
    }
    if (user.role === AppRole.ADMIN || user.chainId !== chainId) {
      throw new ForbiddenException('You can only read branding for your assigned chain');
    }
    if (!user.branchId) throw new ForbiddenException('An assigned branch is required');
    await this.branchAccess.assertCanAccessBranch(user, user.branchId);
  }

  private async getChain(chainId: string) {
    const chain = await this.prisma.restaurantChain.findFirst({
      where: { id: chainId, deletedAt: null },
      include: { branding: true },
    });
    if (!chain) throw new NotFoundException('Restaurant chain not found');
    return chain;
  }
}
