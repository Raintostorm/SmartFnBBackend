import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PayosChannelStatus, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import type { SavePayosChannelDto } from './dto/payos-channel.dto.js';
import { PayosCipherService } from './payos-cipher.service.js';
import { PayosApiError, PayosApiService } from './payos-api.service.js';
import { PayosVerificationStore } from './payos-verification.store.js';

@Injectable()
export class PayosChannelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branchAccess: BranchAccessService,
    private readonly cipher: PayosCipherService,
    private readonly api: PayosApiService,
    private readonly config: ConfigService,
    private readonly verification: PayosVerificationStore,
  ) {}

  async get(chainId: string, user: AuthenticatedUser) {
    await this.branchAccess.assertCanAccessChain(user, chainId);
    const channel = await this.prisma.payosChannel.findUnique({
      where: { chainId },
      select: {
        id: true,
        status: true,
        clientIdLast4: true,
        apiKeyLast4: true,
        lastError: true,
        lastVerifiedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return channel ? { configured: true, ...channel } : { configured: false };
  }

  async save(chainId: string, dto: SavePayosChannelDto, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    // Check local encryption readiness before asking PayOS to change its webhook.
    // Otherwise a missing master key could update PayOS successfully and only then fail to persist.
    this.cipher.assertConfigured();
    const credentials = {
      clientId: dto.clientId.trim(),
      apiKey: dto.apiKey.trim(),
      checksumKey: dto.checksumKey.trim(),
    };
    const existing = await this.prisma.payosChannel.findUnique({
      where: { chainId },
      select: {
        id: true,
        webhookCode: true,
        status: true,
        clientIdLast4: true,
        apiKeyLast4: true,
        lastError: true,
        lastVerifiedAt: true,
      },
    });
    const webhookCode = existing?.webhookCode ?? randomUUID();
    const baseUrl = this.config.get<string>('PAYOS_WEBHOOK_BASE_URL')?.replace(/\/+$/, '');
    if (!baseUrl) {
      throw new ServiceUnavailableException('PAYOS_WEBHOOK_BASE_URL is not configured');
    }
    const webhookUrl = `${baseUrl}/webhooks/payos/${webhookCode}`;
    this.verification.put(webhookCode, chainId, credentials.checksumKey);
    try {
      await this.api.confirmWebhook(credentials, webhookUrl);
    } catch (error) {
      const reason = this.payosError(error);
      await this.prisma.payosChannelAuditLog.create({
        data: {
          chainId,
          channelId: existing?.id,
          actorUserId: user.id,
          action: 'PAYOS_CHANNEL_VERIFICATION_FAILED',
          before: existing ? this.auditView(existing) : Prisma.JsonNull,
          after: Prisma.JsonNull,
          error: reason.message,
        },
      });
      if (reason.temporary) throw new BadGatewayException(reason.message);
      throw new UnprocessableEntityException(reason.message);
    } finally {
      this.verification.remove(webhookCode);
    }

    const verifiedAt = new Date();
    const encrypted = {
      clientIdCipher: this.cipher.encrypt(credentials.clientId),
      apiKeyCipher: this.cipher.encrypt(credentials.apiKey),
      checksumKeyCipher: this.cipher.encrypt(credentials.checksumKey),
      clientIdLast4: credentials.clientId.slice(-4),
      apiKeyLast4: credentials.apiKey.slice(-4),
      status: PayosChannelStatus.LINKED,
      lastError: null,
      lastVerifiedAt: verifiedAt,
      webhookCode,
    };
    const channel = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.payosChannel.upsert({
        where: { chainId },
        create: { chainId, ...encrypted },
        update: encrypted,
        select: {
          id: true,
          status: true,
          clientIdLast4: true,
          apiKeyLast4: true,
          lastError: true,
          lastVerifiedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      await tx.payosChannelAuditLog.create({
        data: {
          chainId,
          channelId: saved.id,
          actorUserId: user.id,
          action: existing ? 'PAYOS_CHANNEL_UPDATED' : 'PAYOS_CHANNEL_CREATED',
          before: existing ? this.auditView(existing) : Prisma.JsonNull,
          after: this.auditView(saved),
        },
      });
      return saved;
    });
    return { configured: true, ...channel };
  }

  async remove(chainId: string, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageChain(user, chainId);
    const existing = await this.prisma.payosChannel.findUnique({ where: { chainId } });
    if (existing) {
      await this.prisma.$transaction(async (tx) => {
        await tx.payosChannel.delete({ where: { id: existing.id } });
        await tx.payosChannelAuditLog.create({
          data: {
            chainId,
            channelId: existing.id,
            actorUserId: user.id,
            action: 'PAYOS_CHANNEL_REMOVED',
            before: this.auditView(existing),
            after: Prisma.JsonNull,
          },
        });
      });
    }
    return { configured: false };
  }

  private payosError(error: unknown) {
    if (error instanceof PayosApiError) {
      return { message: error.message.slice(0, 1000), temporary: error.temporary };
    }
    return { message: 'PayOS verification failed', temporary: true };
  }

  private auditView(value: {
    status?: PayosChannelStatus;
    clientIdLast4?: string | null;
    apiKeyLast4?: string | null;
    lastError?: string | null;
    lastVerifiedAt?: Date | null;
  }): Prisma.InputJsonValue {
    return {
      status: value.status ?? PayosChannelStatus.LINKED,
      clientIdLast4: value.clientIdLast4 ?? null,
      apiKeyLast4: value.apiKeyLast4 ?? null,
      lastError: value.lastError ?? null,
      lastVerifiedAt: value.lastVerifiedAt?.toISOString() ?? null,
    };
  }
}
