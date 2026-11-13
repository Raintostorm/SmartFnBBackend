import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { PrismaService } from '../../database/prisma.service.js';
import { AppRole } from '../auth/app-role.enum.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { auditSnapshot, writeChainAudit } from '../audit/chain-audit.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import { deleteAsset, putAsset } from '../assets/asset-storage.js';
import type { UpdateBrandingDto } from './dto/branding.dto.js';
import { PlanQuotaService } from '../subscription/plan-quota.service.js';
import { BRANDING_LOGO_MAX_BYTES, BRANDING_LOGO_PUBLIC_PREFIX } from './branding-upload.js';

const DEFAULT_BRANDING = {
  primaryColor: '#0F172A',
  secondaryColor: '#FFFFFF',
  accentColor: '#22C55E',
} as const;

interface BrandingLogoFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

const IMAGE_FORMATS = [
  {
    mimeType: 'image/jpeg',
    extension: 'jpg',
    matches: (buffer: Buffer) =>
      buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  },
  {
    mimeType: 'image/png',
    extension: 'png',
    matches: (buffer: Buffer) =>
      buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mimeType: 'image/webp',
    extension: 'webp',
    matches: (buffer: Buffer) =>
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP',
  },
] as const;

const BRANDING_AUDIT_KEYS = ['displayName', 'logoUrl', 'primaryColor', 'secondaryColor', 'accentColor'] as const;

@Injectable()
export class BrandingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branchAccess: BranchAccessService,
    private readonly plans: PlanQuotaService,
  ) {}

  async get(chainId: string, user: AuthenticatedUser) {
    await this.assertCanRead(chainId, user);
    await this.plans.assertFeatureEnabled(chainId, 'BRANDING');
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
    await this.plans.assertFeatureEnabled(chainId, 'BRANDING');
    const chain = await this.getChain(chainId);
    const previousLogoUrl = chain.branding?.logoUrl ?? chain.logoUrl;
    const branding = await this.prisma.$transaction(async (tx) => {
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
      await writeChainAudit(tx, user, chainId, { action: 'BRANDING_UPDATED', entityType: 'BusinessBranding', entityId: branding.id, before: auditSnapshot(chain.branding, BRANDING_AUDIT_KEYS), after: auditSnapshot(branding, BRANDING_AUDIT_KEYS) });
      return branding;
    });
    if (dto.logoUrl !== undefined && dto.logoUrl !== previousLogoUrl) {
      await this.removeManagedLogo(previousLogoUrl);
    }
    return branding;
  }

  async uploadLogo(chainId: string, file: BrandingLogoFile | undefined, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    await this.plans.assertFeatureEnabled(chainId, 'BRANDING');
    const chain = await this.getChain(chainId);
    const extension = this.validateLogo(file);
    const fileName = `${chainId}-${Date.now()}-${randomUUID()}.${extension}`;
    const key = `branding/${fileName}`;
    const logoUrl = `${BRANDING_LOGO_PUBLIC_PREFIX}/${fileName}`;
    await putAsset(key, file!.buffer);

    let branding;
    try {
      branding = await this.prisma.$transaction(async (tx) => {
        const saved = await tx.businessBranding.upsert({
          where: { chainId },
          create: {
            chainId,
            displayName: chain.name,
            logoUrl,
            ...DEFAULT_BRANDING,
          },
          update: { logoUrl },
        });
        await tx.restaurantChain.update({ where: { id: chainId }, data: { logoUrl } });
        await writeChainAudit(tx, user, chainId, { action: 'BRANDING_LOGO_UPLOADED', entityType: 'BusinessBranding', entityId: saved.id, before: { logoUrl: chain.branding?.logoUrl ?? chain.logoUrl ?? null }, after: { logoUrl } });
        return saved;
      });
    } catch (error) {
      await deleteAsset(key).catch(() => undefined);
      throw error;
    }

    await this.removeManagedLogo(chain.branding?.logoUrl ?? chain.logoUrl);
    return branding;
  }

  async reset(chainId: string, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    await this.plans.assertFeatureEnabled(chainId, 'BRANDING');
    const chain = await this.getChain(chainId);
    const previousLogoUrl = chain.branding?.logoUrl ?? chain.logoUrl;
    const branding = await this.prisma.$transaction(async (tx) => {
      await tx.restaurantChain.update({ where: { id: chainId }, data: { logoUrl: null } });
      const saved = await tx.businessBranding.upsert({
        where: { chainId },
        create: { chainId, displayName: chain.name, ...DEFAULT_BRANDING },
        update: { displayName: chain.name, logoUrl: null, ...DEFAULT_BRANDING },
      });
      await writeChainAudit(tx, user, chainId, { action: 'BRANDING_RESET', entityType: 'BusinessBranding', entityId: saved.id, before: auditSnapshot(chain.branding, BRANDING_AUDIT_KEYS), after: auditSnapshot(saved, BRANDING_AUDIT_KEYS) });
      return saved;
    });
    await this.removeManagedLogo(previousLogoUrl);
    return branding;
  }

  private validateLogo(file: BrandingLogoFile | undefined): string {
    if (!file?.buffer?.length) {
      throw new BadRequestException('A logo file is required');
    }
    if (file.size > BRANDING_LOGO_MAX_BYTES || file.buffer.length > BRANDING_LOGO_MAX_BYTES) {
      throw new BadRequestException('Logo must not exceed 5 MB');
    }
    const format = IMAGE_FORMATS.find(({ mimeType }) => mimeType === file.mimetype);
    if (!format || !format.matches(file.buffer)) {
      throw new BadRequestException('Logo must be a valid JPEG, PNG, or WebP image');
    }
    return format.extension;
  }

  private async removeManagedLogo(logoUrl: string | null | undefined): Promise<void> {
    if (!logoUrl?.startsWith(`${BRANDING_LOGO_PUBLIC_PREFIX}/`)) return;
    const fileName = logoUrl.slice(BRANDING_LOGO_PUBLIC_PREFIX.length + 1);
    if (!fileName || basename(fileName) !== fileName) return;
    await deleteAsset(`branding/${fileName}`).catch(() => undefined);
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
