import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import { deleteAsset, putAsset } from '../assets/asset-storage.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import type { UpdateDisplayPosterDto } from './dto/display-poster.dto.js';
import { PlanQuotaService } from '../subscription/plan-quota.service.js';

export const POSTER_MAX_BYTES = 5 * 1024 * 1024;
export const POSTER_LIMIT = 10;
export const posterOrder = [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] as const;
export interface PosterFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

@Injectable()
export class DisplayPostersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BranchAccessService,
    private readonly plans: PlanQuotaService,
  ) {}

  async list(chainId: string, user: AuthenticatedUser) {
    await this.access.assertCanAccessChain(user, chainId);
    await this.plans.assertFeatureEnabled(chainId, 'BRANDING');
    return this.prisma.displayPoster.findMany({
      where: { chainId, deletedAt: null },
      orderBy: [...posterOrder],
    });
  }

  async upload(chainId: string, file: PosterFile | undefined, user: AuthenticatedUser) {
    await this.access.assertCanManageChain(user, chainId);
    await this.plans.assertFeatureEnabled(chainId, 'BRANDING');
    const extension = this.validateImage(file);
    const fileName = `${chainId}-${randomUUID()}.${extension}`;
    const key = `posters/${fileName}`;
    await putAsset(key, file!.buffer);
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialize uploads for one tenant so parallel requests cannot bypass the limit.
        await tx.$queryRaw`SELECT id FROM restaurant_chains WHERE id = ${chainId}::uuid FOR UPDATE`;
        const count = await tx.displayPoster.count({ where: { chainId, deletedAt: null } });
        if (count >= POSTER_LIMIT)
          throw new ConflictException(
            'A chain may have at most 10 posters; remove one before uploading',
          );
        return tx.displayPoster.create({
          data: {
            chainId,
            title: 'Poster',
            imageUrl: `/uploads/posters/${fileName}`,
            sortOrder: count,
          },
        });
      });
    } catch (error) {
      await deleteAsset(key).catch(() => undefined);
      throw error;
    }
  }

  async update(chainId: string, id: string, dto: UpdateDisplayPosterDto, user: AuthenticatedUser) {
    await this.access.assertCanManageChain(user, chainId);
    await this.plans.assertFeatureEnabled(chainId, 'BRANDING');
    if (!Object.values(dto).some((value) => value !== undefined))
      throw new BadRequestException('At least one poster field is required');
    // Scoped unique update: never mutate an ID from another chain or a removed poster.
    const result = await this.prisma.displayPoster.updateMany({
      where: { id, chainId, deletedAt: null },
      data: dto,
    });
    if (!result.count) throw new NotFoundException('Poster not found in this chain');
    return this.prisma.displayPoster.findFirst({ where: { id, chainId, deletedAt: null } });
  }

  async remove(chainId: string, id: string, user: AuthenticatedUser) {
    await this.access.assertCanManageChain(user, chainId);
    await this.plans.assertFeatureEnabled(chainId, 'BRANDING');
    const result = await this.prisma.displayPoster.updateMany({
      where: { id, chainId, deletedAt: null },
      data: { deletedAt: new Date(), enabled: false },
    });
    if (!result.count) throw new NotFoundException('Poster not found in this chain');
    // Retain the asset: displays may still be showing the previous context until next sync.
    return { deleted: true };
  }

  private validateImage(file: PosterFile | undefined) {
    if (!file?.buffer?.length) throw new BadRequestException('A poster file is required');
    if (file.size > POSTER_MAX_BYTES || file.buffer.length > POSTER_MAX_BYTES)
      throw new BadRequestException('Poster must not exceed 5 MB');
    const b = file.buffer;
    if (
      file.mimetype === 'image/png' &&
      b.length >= 24 &&
      b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      return 'png';
    if (
      file.mimetype === 'image/jpeg' &&
      b.length >= 4 &&
      b[0] === 255 &&
      b[1] === 216 &&
      b[2] === 255
    )
      return 'jpg';
    if (
      file.mimetype === 'image/webp' &&
      b.length >= 16 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP'
    )
      return 'webp';
    throw new BadRequestException(
      'Poster must be a JPEG, PNG, or WebP image with a matching file signature',
    );
  }
}
