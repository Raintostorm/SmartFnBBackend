import { ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Prisma, UserStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { EmailOutboxService } from '../email/email-outbox.service.js';
import { AppRole } from './app-role.enum.js';
import type { AuthenticatedUser, RequestMetadata } from './auth.interfaces.js';
import { PasswordService } from './password.service.js';
import { PasswordResetEvents } from './password-reset.events.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const RESPONSE = { message: 'Nếu email đúng, hướng dẫn đặt lại đã được gửi đi' };

@Injectable()
export class PasswordResetService implements OnModuleInit, OnModuleDestroy {
  private expiryTimer?: NodeJS.Timeout;
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly emails: EmailOutboxService,
    private readonly events: PasswordResetEvents,
  ) {}

  onModuleInit() {
    this.expiryTimer = setInterval(() => void this.expireOldRequests().catch(() => undefined), 5 * 60_000);
    this.expiryTimer.unref();
    void this.expireOldRequests().catch(() => undefined);
  }

  onModuleDestroy() { if (this.expiryTimer) clearInterval(this.expiryTimer); }

  private async expireOldRequests() {
    const now = new Date();
    await this.prisma.passwordResetRequest.updateMany({ where: { status: 'PENDING', expiresAt: { lte: now } }, data: { status: 'EXPIRED', handledAt: now } });
    await this.prisma.passwordResetAttempt.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - DAY) } } });
    const queued = await this.prisma.emailOutbox.findMany({
      where: { template: { in: ['SELF_PASSWORD_RESET', 'PASSWORD_RESET'] }, status: { in: ['PENDING', 'FAILED'] }, attempts: { lt: 3 }, createdAt: { gt: new Date(now.getTime() - DAY) } },
      select: { id: true, payload: true }, orderBy: { createdAt: 'asc' }, take: 50,
    });
    for (const item of queued) {
      const token = (item.payload as { setupToken?: unknown }).setupToken;
      if (typeof token !== 'string') continue;
      const valid = await this.prisma.passwordSetupToken.count({ where: { tokenHash: this.hashToken(token), usedAt: null, cancelledAt: null, expiresAt: { gt: now } } });
      if (valid) await this.emails.deliver(item.id);
    }
  }

  async request(email: string, metadata: RequestMetadata) {
    const now = new Date();
    const ip = (metadata.ipAddress || 'unknown').slice(0, 64);
    const allowed = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${ip}))`;
      const attempts = await tx.passwordResetAttempt.count({ where: { ipAddress: ip, createdAt: { gt: new Date(now.getTime() - HOUR) } } });
      if (attempts >= 5) return false;
      await tx.passwordResetAttempt.create({ data: { ipAddress: ip } });
      return true;
    });
    if (!allowed) throw new HttpException(RESPONSE, 429);

    const user = await this.prisma.user.findFirst({
      where: { email: email.trim().toLowerCase(), deletedAt: null },
      include: { role: { select: { code: true } }, employee: { select: { branch: { select: { chainId: true } } } }, owner: { select: { chainAssignments: { select: { chainId: true }, take: 1 } } } },
    });
    if (!user || user.status !== UserStatus.ACTIVE || user.staffInvitationState === 'CANCELLED') return RESPONSE;
    const role = user.role.code;
    if (role === AppRole.ADMIN) return RESPONSE;
    if (role === AppRole.CASHIER || role === AppRole.BARISTA) {
      await this.selfReset(user.id, user.email, ip, now);
      return RESPONSE;
    }
    if (user.status !== UserStatus.ACTIVE) return RESPONSE;
    if (![AppRole.MANAGER, AppRole.OWNER, AppRole.PLATFORM_STAFF].includes(role as AppRole) || user.staffInvitationState === 'PENDING') return RESPONSE;
    const chainId = (role === AppRole.MANAGER ? user.employee?.branch.chainId : role === AppRole.OWNER ? user.owner?.chainAssignments[0]?.chainId : null) ?? null;
    if (role !== AppRole.PLATFORM_STAFF && !chainId) return RESPONSE;
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        await tx.passwordResetRequest.updateMany({ where: { userId: user.id, status: 'PENDING', expiresAt: { lte: now } }, data: { status: 'EXPIRED', handledAt: now } });
        const latest = await tx.passwordResetRequest.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
        if (latest?.status === 'PENDING' || (latest && now.getTime() - latest.createdAt.getTime() < 15 * 60_000)) return null;
        return tx.passwordResetRequest.create({ data: { userId: user.id, scopeChainId: chainId, ipAddress: ip, userAgent: metadata.userAgent?.slice(0, 500), expiresAt: new Date(now.getTime() + DAY) } });
      });
      if (created) this.events.publish({ type: 'password-reset.requested', chainId: role === AppRole.MANAGER ? chainId : null, requestId: created.id });
    } catch (error) {
      // A partial unique index permits just one pending request even under concurrent clicks.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
    }
    return RESPONSE;
  }

  private async selfReset(userId: string, email: string, ip: string, now: Date) {
    const latest = await this.prisma.passwordSetupToken.findFirst({ where: { userId, purpose: 'SELF_RESET' }, orderBy: { createdAt: 'desc' } });
    if (latest && now.getTime() - latest.createdAt.getTime() < 2 * 60_000) return;
    const hourly = await this.prisma.passwordSetupToken.count({ where: { userId, purpose: 'SELF_RESET', createdAt: { gt: new Date(now.getTime() - HOUR) } } });
    if (hourly >= 5) return;
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + 30 * 60_000);
    const mailId = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      const current = await tx.user.findUnique({ where: { id: userId }, select: { status: true, staffInvitationState: true } });
      if (!current || current.status === UserStatus.SUSPENDED || current.staffInvitationState === 'CANCELLED') return null;
      const recent = await tx.passwordSetupToken.findFirst({ where: { userId, purpose: 'SELF_RESET' }, orderBy: { createdAt: 'desc' } });
      if (recent && now.getTime() - recent.createdAt.getTime() < 2 * 60_000) return null;
      const sentThisHour = await tx.passwordSetupToken.count({ where: { userId, purpose: 'SELF_RESET', createdAt: { gt: new Date(now.getTime() - HOUR) } } });
      if (sentThisHour >= 5) return null;
      await tx.passwordSetupToken.updateMany({ where: { userId, usedAt: null, cancelledAt: null }, data: { cancelledAt: now } });
      await tx.passwordSetupToken.create({ data: { userId, tokenHash: this.hashToken(token), purpose: 'SELF_RESET', requestIpAddress: ip, expiresAt } });
      const mail = await tx.emailOutbox.create({ data: { recipient: email, subject: 'Đặt lại mật khẩu Smart F&B', template: 'SELF_PASSWORD_RESET', payload: { setupToken: token, setupPath: '/setup-password', expiresAt: expiresAt.toISOString(), selfReset: true } } });
      return mail.id;
    });
    if (mailId) await this.emails.deliver(mailId);
  }

  async list(actor: AuthenticatedUser) {
    const now = new Date();
    await this.prisma.passwordResetRequest.updateMany({ where: { status: 'PENDING', expiresAt: { lte: now } }, data: { status: 'EXPIRED', handledAt: now } });
    const scope = this.scope(actor);
    return this.prisma.passwordResetRequest.findMany({ where: { ...scope, createdAt: { gt: new Date(now.getTime() - 30 * DAY) } }, include: { user: { select: { email: true, status: true, role: { select: { code: true } }, employee: { select: { firstName: true, lastName: true } }, owner: { select: { firstName: true, lastName: true } } } }, handledBy: { select: { email: true } } }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  async count(actor: AuthenticatedUser) {
    return { count: await this.prisma.passwordResetRequest.count({ where: { ...this.scope(actor), status: 'PENDING', expiresAt: { gt: new Date() } } }) };
  }

  async resolve(actor: AuthenticatedUser, id: string, note?: string) {
    const reject = note !== undefined;
    if (reject && !note?.trim()) throw new ConflictException('Rejection note is required');
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + DAY);
    await this.prisma.passwordResetRequest.updateMany({ where: { id, status: 'PENDING', expiresAt: { lte: now } }, data: { status: 'EXPIRED', handledAt: now } });
    const invalidHash = reject ? null : await this.passwords.hash(randomBytes(48).toString('base64url'));
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM password_reset_requests WHERE id = ${id}::uuid FOR UPDATE`;
      const item = await tx.passwordResetRequest.findUnique({ where: { id }, include: { user: { include: { role: true } }, handledBy: { select: { email: true } } } });
      if (!item || !this.canHandle(actor, item.user.role.code, item.scopeChainId)) throw new NotFoundException('Request not found');
      if (item.status !== 'PENDING') throw new ConflictException(`Đã được ${item.handledBy?.email ?? 'người khác'} xử lý`);
      if (item.expiresAt <= now) throw new ConflictException('Request expired');
      if (!reject && item.user.status !== UserStatus.ACTIVE) throw new ForbiddenException('Locked account can only be rejected');
      await tx.passwordResetRequest.update({ where: { id }, data: { status: reject ? 'REJECTED' : 'RESET', handledById: actor.id, handledAt: now, rejectionNote: note?.trim() } });
      if (reject) return { emailId: null, chainId: item.user.role.code === AppRole.MANAGER ? item.scopeChainId : null };
      await tx.passwordSetupToken.updateMany({ where: { userId: item.userId, usedAt: null, cancelledAt: null }, data: { cancelledAt: now } });
      await tx.passwordSetupToken.create({ data: { userId: item.userId, tokenHash: this.hashToken(token), purpose: 'SUPERIOR_RESET', expiresAt } });
      await tx.user.update({ where: { id: item.userId }, data: { passwordHash: invalidHash!, status: UserStatus.INACTIVE, staffInvitationState: item.user.role.code === AppRole.MANAGER ? 'PENDING' : item.user.staffInvitationState } });
      await tx.authSession.updateMany({ where: { userId: item.userId, revokedAt: null }, data: { revokedAt: now } });
      const mail = await tx.emailOutbox.create({ data: { recipient: item.user.email, subject: 'Đặt mật khẩu mới Smart F&B', template: 'PASSWORD_RESET', payload: { setupToken: token, setupPath: '/setup-password', expiresAt: expiresAt.toISOString(), employeeName: item.user.email } } });
      return { emailId: mail.id, chainId: item.user.role.code === AppRole.MANAGER ? item.scopeChainId : null };
    });
    if (result.emailId) await this.emails.deliver(result.emailId);
    this.events.publish({ type: 'password-reset.resolved', chainId: result.chainId, requestId: id });
    return { status: reject ? 'REJECTED' : 'RESET' };
  }

  async resend(actor: AuthenticatedUser, id: string) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + DAY);
    const token = randomBytes(32).toString('base64url');
    const mail = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM password_reset_requests WHERE id = ${id}::uuid FOR UPDATE`;
      const item = await tx.passwordResetRequest.findUnique({ where: { id }, include: { user: { include: { role: true } } } });
      if (!item || !this.canHandle(actor, item.user.role.code, item.scopeChainId)) throw new NotFoundException('Request not found');
      if (item.status !== 'RESET' || item.user.status !== UserStatus.INACTIVE) throw new ConflictException('This account is not waiting for a reset link');
      const latest = await tx.passwordSetupToken.findFirst({ where: { userId: item.userId, purpose: 'SUPERIOR_RESET' }, orderBy: { createdAt: 'desc' } });
      if (latest && now.getTime() - latest.createdAt.getTime() < 60_000) throw new HttpException('Wait 60 seconds before resending', 429);
      await tx.passwordSetupToken.updateMany({ where: { userId: item.userId, usedAt: null, cancelledAt: null }, data: { cancelledAt: now } });
      await tx.passwordSetupToken.create({ data: { userId: item.userId, tokenHash: this.hashToken(token), purpose: 'SUPERIOR_RESET', expiresAt } });
      return tx.emailOutbox.create({ data: { recipient: item.user.email, subject: 'Liên kết đặt mật khẩu mới Smart F&B', template: 'PASSWORD_RESET', payload: { setupToken: token, setupPath: '/setup-password', expiresAt: expiresAt.toISOString(), employeeName: item.user.email } } });
    });
    return { expiresAt, emailStatus: await this.emails.deliver(mail.id) };
  }

  private scope(actor: AuthenticatedUser): Prisma.PasswordResetRequestWhereInput {
    if (actor.role === AppRole.ADMIN) return { user: { role: { code: { in: [AppRole.PLATFORM_STAFF, AppRole.OWNER] } } } };
    if (actor.role === AppRole.PLATFORM_STAFF) return { user: { role: { code: AppRole.OWNER } } };
    if (actor.role === AppRole.OWNER) return { scopeChainId: { in: actor.chainIds }, user: { role: { code: AppRole.MANAGER } } };
    throw new ForbiddenException('This role cannot process password reset requests');
  }

  private canHandle(actor: AuthenticatedUser, role: string, chainId: string | null) {
    return (actor.role === AppRole.ADMIN && [AppRole.PLATFORM_STAFF, AppRole.OWNER].includes(role as AppRole)) ||
      (actor.role === AppRole.PLATFORM_STAFF && role === AppRole.OWNER) ||
      (actor.role === AppRole.OWNER && role === AppRole.MANAGER && !!chainId && actor.chainIds.includes(chainId));
  }

  private hashToken(token: string) { return createHash('sha256').update(token).digest('hex'); }
}
