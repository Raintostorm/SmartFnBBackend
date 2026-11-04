import { ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { UserStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AppRole } from '../auth/app-role.enum.js';
import { PasswordService } from '../auth/password.service.js';
import { EmailOutboxService } from '../email/email-outbox.service.js';

const SETUP_LINK_TTL_MS = 24 * 60 * 60_000;

@Injectable()
export class PlatformStaffAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly emails: EmailOutboxService,
  ) {}

  async list() {
    const users = await this.prisma.user.findMany({
      where: { role: { code: AppRole.PLATFORM_STAFF }, deletedAt: null },
      select: {
        id: true, email: true, status: true, staffInvitationState: true,
        emailVerifiedAt: true, createdAt: true, lastLoginAt: true,
        passwordSetupTokens: {
          where: { usedAt: null }, orderBy: { createdAt: 'desc' }, take: 1,
          select: { expiresAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return users.map(({ passwordSetupTokens, ...user }) => ({
      ...user,
      invitationExpiresAt: passwordSetupTokens[0]?.expiresAt ?? null,
    }));
  }

  async create(emailInput: string, note: string, actorUserId: string) {
    const email = emailInput.trim().toLowerCase();
    const role = await this.prisma.role.findUnique({ where: { code: AppRole.PLATFORM_STAFF } });
    if (!role) throw new ConflictException('PLATFORM_STAFF role is not seeded');
    if (await this.prisma.user.count({ where: { email } }))
      throw new ConflictException('Email already belongs to an account');

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SETUP_LINK_TTL_MS);
    const passwordHash = await this.passwords.hash(randomBytes(48).toString('base64url'));
    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email, roleId: role.id, passwordHash, status: UserStatus.INACTIVE,
          staffInvitationState: 'PENDING',
        },
      });
      await tx.passwordSetupToken.create({
        data: { userId: user.id, tokenHash: this.hashToken(token), expiresAt },
      });
      const message = await tx.emailOutbox.create({
        data: {
          recipient: email,
          subject: 'Thiết lập tài khoản Platform Staff Smart F&B',
          template: 'PLATFORM_STAFF_INVITATION',
          payload: { employeeName: 'Platform Staff', setupToken: token, setupPath: '/setup-password', expiresAt: expiresAt.toISOString() },
        },
      });
      await tx.platformSupportAction.create({
        data: { actorUserId, action: 'CREATE_PLATFORM_STAFF', note: note.trim(), details: { userId: user.id, email } },
      });
      return { userId: user.id, emailId: message.id };
    });
    return {
      id: result.userId, email, status: UserStatus.INACTIVE,
      staffInvitationState: 'PENDING', invitationExpiresAt: expiresAt,
      emailStatus: await this.emails.deliver(result.emailId),
    };
  }

  async setLocked(id: string, locked: boolean, note: string, actorUserId: string) {
    const user = await this.requireStaff(id);
    const status = locked ? UserStatus.SUSPENDED : user.emailVerifiedAt ? UserStatus.ACTIVE : UserStatus.INACTIVE;
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { status } });
      if (locked) {
        await tx.authSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
        await tx.passwordSetupToken.updateMany({ where: { userId: id, usedAt: null }, data: { usedAt: new Date() } });
      }
      await tx.platformSupportAction.create({
        data: { actorUserId, action: locked ? 'LOCK_PLATFORM_STAFF' : 'UNLOCK_PLATFORM_STAFF', note: note.trim(), details: { userId: id, email: user.email } },
      });
    });
    return { id, email: user.email, status };
  }

  async resetPassword(id: string, note: string, actorUserId: string) {
    const user = await this.requireStaff(id);
    if (user.status === UserStatus.SUSPENDED)
      throw new ConflictException('Unlock the account before sending a password setup link');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SETUP_LINK_TTL_MS);
    const isInvitation = !user.emailVerifiedAt;
    const result = await this.prisma.$transaction(async (tx) => {
      const latest = await tx.passwordSetupToken.findFirst({
        where: { userId: id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true },
      });
      if (latest && Date.now() - latest.createdAt.getTime() < 60_000)
        throw new HttpException('Wait 60 seconds before requesting another email', 429);
      await tx.passwordSetupToken.updateMany({ where: { userId: id, usedAt: null }, data: { usedAt: new Date() } });
      await tx.passwordSetupToken.create({ data: { userId: id, tokenHash: this.hashToken(token), expiresAt } });
      await tx.authSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      const message = await tx.emailOutbox.create({
        data: {
          recipient: user.email,
          subject: isInvitation ? 'Liên kết thiết lập tài khoản Platform Staff' : 'Đặt lại mật khẩu Platform Staff',
          template: isInvitation ? 'PLATFORM_STAFF_INVITATION' : 'PLATFORM_STAFF_PASSWORD_RESET',
          payload: { employeeName: 'Platform Staff', setupToken: token, setupPath: '/setup-password', expiresAt: expiresAt.toISOString() },
        },
      });
      await tx.platformSupportAction.create({
        data: { actorUserId, action: isInvitation ? 'RESEND_PLATFORM_STAFF_INVITATION' : 'RESET_PLATFORM_STAFF_PASSWORD', note: note.trim(), details: { userId: id, email: user.email } },
      });
      return message.id;
    });
    return { id, email: user.email, invitationExpiresAt: expiresAt, emailStatus: await this.emails.deliver(result) };
  }

  private async requireStaff(id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null, role: { code: AppRole.PLATFORM_STAFF } },
      select: { id: true, email: true, status: true, emailVerifiedAt: true },
    });
    if (!user) throw new NotFoundException('Platform Staff account not found');
    return user;
  }

  private hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }
}
