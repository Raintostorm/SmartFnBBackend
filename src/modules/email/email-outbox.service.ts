import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailOutboxStatus, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';

type SetupPayload = {
  employeeName?: string;
  branchName?: string;
  role?: string;
  setupToken?: string;
  setupPath?: string;
  expiresAt?: string;
};

@Injectable()
export class EmailOutboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async deliver(id: string): Promise<EmailOutboxStatus> {
    const message = await this.prisma.emailOutbox.findUnique({ where: { id } });
    if (!message || message.status === EmailOutboxStatus.SENT) {
      return message?.status ?? EmailOutboxStatus.FAILED;
    }
    const apiKey = this.config.get<string>('EMAIL_API_KEY')?.trim();
    const from = this.config.get<string>('EMAIL_FROM')?.trim();
    if (!apiKey || !from) return EmailOutboxStatus.PENDING;

    const payload = message.payload as SetupPayload;
    const publicWebUrl = this.config.get<string>('PUBLIC_WEB_URL')!.replace(/\/+$/, '');
    const setupPath = `/${String(payload.setupPath ?? '/setup-password').replace(/^\/+/, '')}`;
    const setupUrl = `${publicWebUrl}${setupPath}?token=${encodeURIComponent(payload.setupToken ?? '')}`;
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [message.recipient],
          subject: message.subject,
          html: this.setupHtml(payload, setupUrl),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Email provider rejected the request (${response.status}) ${body}`.trim());
      }
      await this.prisma.emailOutbox.update({
        where: { id },
        data: {
          status: EmailOutboxStatus.SENT,
          attempts: { increment: 1 },
          lastError: null,
          sentAt: new Date(),
        },
      });
      return EmailOutboxStatus.SENT;
    } catch (error) {
      await this.prisma.emailOutbox.update({
        where: { id },
        data: {
          status: EmailOutboxStatus.FAILED,
          attempts: { increment: 1 },
          lastError: String(error instanceof Error ? error.message : error).slice(0, 1000),
        },
      });
      return EmailOutboxStatus.FAILED;
    }
  }

  private setupHtml(payload: SetupPayload, setupUrl: string): string {
    const name = this.escape(payload.employeeName ?? 'nhân viên');
    const branch = payload.branchName ? ` tại ${this.escape(payload.branchName)}` : '';
    const expiresAt = payload.expiresAt ? new Date(payload.expiresAt).toLocaleString('vi-VN') : '';
    return `<p>Xin chào ${name},</p><p>Tài khoản Smart F&B${branch} đã được tạo.</p><p><a href="${this.escape(setupUrl)}">Đặt mật khẩu</a></p><p>Liên kết chỉ dùng một lần${expiresAt ? ` và hết hạn lúc ${this.escape(expiresAt)}` : ''}.</p>`;
  }

  private escape(value: string): string {
    return value.replace(
      /[&<>"']/g,
      (char) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[char]!,
    );
  }
}
