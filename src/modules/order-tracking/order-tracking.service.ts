import { GoneException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { OrderStatus, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';

const TERMINAL_GRACE_MS = 30 * 60_000;
const DEFAULT_TOKEN_TTL_MS = 36 * 60 * 60_000;

@Injectable()
export class OrderTrackingService {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async ensureForOrder(tx: Prisma.TransactionClient, orderId: string) {
    let record = await tx.orderTrackingToken.findUnique({ where: { orderId } });
    if (!record) {
      const tokenSalt = randomBytes(24).toString('base64url');
      const token = this.derive(orderId, tokenSalt);
      record = await tx.orderTrackingToken.create({
        data: {
          orderId,
          tokenSalt,
          tokenHash: this.hash(token),
          expiresAt: new Date(Date.now() + DEFAULT_TOKEN_TTL_MS),
        },
      });
    }
    return this.presentation(orderId, record.tokenSalt);
  }

  async presentationForOrder(orderId: string) {
    const record = await this.prisma.orderTrackingToken.findUnique({ where: { orderId } });
    return record ? this.presentation(orderId, record.tokenSalt) : null;
  }

  async markTerminal(tx: Prisma.TransactionClient, orderId: string, at = new Date()) {
    await tx.orderTrackingToken.updateMany({
      where: { orderId, terminalAt: null },
      data: { terminalAt: at },
    });
  }

  async track(token: string, clientKey: string) {
    this.assertRateLimit(clientKey);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundException('Tracking link not found');
    const now = new Date();
    const record = await this.prisma.orderTrackingToken.findUnique({
      where: { tokenHash: this.hash(token) },
      include: {
        order: {
          select: {
            status: true,
            paymentStatus: true,
            callNumber: true,
            readyAt: true,
            deliveredAt: true,
            cancelledAt: true,
            updatedAt: true,
            branch: {
              select: {
                name: true,
                chain: {
                  select: {
                    name: true,
                    logoUrl: true,
                    branding: {
                      select: { displayName: true, logoUrl: true, primaryColor: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!record) throw new NotFoundException('Tracking link not found');
    if (
      record.revokedAt ||
      record.expiresAt <= now ||
      (record.terminalAt && record.terminalAt.getTime() + TERMINAL_GRACE_MS <= now.getTime())
    ) {
      throw new GoneException('Tracking link has expired');
    }
    await this.prisma.orderTrackingToken.update({
      where: { id: record.id },
      data: { lastAccessedAt: now },
    });
    const branding = record.order.branch.chain.branding;
    return {
      callNumber: record.order.callNumber,
      status: record.order.status,
      displayStatus: this.displayStatus(record.order.status),
      branch: { name: record.order.branch.name },
      branding: {
        displayName: branding?.displayName ?? record.order.branch.chain.name,
        logoUrl: branding?.logoUrl ?? record.order.branch.chain.logoUrl,
        primaryColor: branding?.primaryColor ?? '#0F172A',
      },
      readyAt: record.order.readyAt,
      deliveredAt: record.order.deliveredAt,
      cancelledAt: record.order.cancelledAt,
      updatedAt: record.order.updatedAt,
      pollAfterSeconds: 4,
    };
  }

  private presentation(orderId: string, tokenSalt: string) {
    const token = this.derive(orderId, tokenSalt);
    const base = String(this.config.get('PUBLIC_WEB_URL') ?? 'http://localhost:8443').replace(
      /\/+$/,
      '',
    );
    return { token, url: `${base}/t/${token}` };
  }

  private derive(orderId: string, salt: string) {
    const secret = String(
      this.config.get('ORDER_TRACKING_SECRET') ?? 'local-order-tracking-secret-change-me',
    );
    return createHmac('sha256', secret).update(`${orderId}.${salt}`).digest('base64url');
  }

  private hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private displayStatus(status: OrderStatus) {
    if (status === OrderStatus.READY) return 'READY_FOR_PICKUP';
    if (status === OrderStatus.DELIVERED || status === OrderStatus.COMPLETED) return 'DELIVERED';
    if (status === OrderStatus.CANCELLED) return 'CANCELLED';
    return 'PREPARING';
  }

  private assertRateLimit(key: string) {
    const now = Date.now();
    const current = this.attempts.get(key);
    if (!current || current.resetAt <= now) {
      this.attempts.set(key, { count: 1, resetAt: now + 60_000 });
      return;
    }
    current.count += 1;
    if (current.count > 30) throw new HttpException('Too many tracking requests', 429);
    if (this.attempts.size > 10_000) {
      for (const [entry, value] of this.attempts)
        if (value.resetAt <= now) this.attempts.delete(entry);
    }
  }
}
