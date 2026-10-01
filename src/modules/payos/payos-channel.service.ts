import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import type { SavePayosChannelDto } from './dto/payos-channel.dto.js';
import { PayosCipherService } from './payos-cipher.service.js';

@Injectable()
export class PayosChannelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branchAccess: BranchAccessService,
    private readonly cipher: PayosCipherService,
  ) {}

  async get(chainId: string, user: AuthenticatedUser) {
    await this.branchAccess.assertCanAccessChain(user, chainId);
    const channel = await this.prisma.payosChannel.findUnique({
      where: { chainId },
      select: { id: true, createdAt: true, updatedAt: true },
    });
    return channel ? { configured: true, ...channel } : { configured: false };
  }

  async save(chainId: string, dto: SavePayosChannelDto, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    const encrypted = {
      clientIdCipher: this.cipher.encrypt(dto.clientId.trim()),
      apiKeyCipher: this.cipher.encrypt(dto.apiKey.trim()),
      checksumKeyCipher: this.cipher.encrypt(dto.checksumKey.trim()),
    };
    const channel = await this.prisma.payosChannel.upsert({
      where: { chainId },
      create: { chainId, ...encrypted },
      update: encrypted,
      select: { id: true, createdAt: true, updatedAt: true },
    });
    return { configured: true, ...channel };
  }

  async remove(chainId: string, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    await this.prisma.payosChannel.deleteMany({ where: { chainId } });
    return { configured: false };
  }
}
