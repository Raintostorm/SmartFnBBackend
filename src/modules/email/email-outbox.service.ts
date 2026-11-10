import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailOutboxStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';

type SetupPayload = {
  employeeName?: string;
  branchName?: string;
  businessName?: string;
  daysRemaining?: number;
  trialEndsAt?: string;
  role?: string;
  planName?: string;
  checkoutUrl?: string;
  amount?: number;
  representativeName?: string;
  rejectionReason?: string;
  setupToken?: string;
  setupPath?: string;
  expiresAt?: string;
  heading?: string;
  paragraphs?: string[];
  lines?: Array<{ description: string; quantity: number; amount: number }>;
  total?: number;
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
    const html =
      message.template === 'REGISTRATION_ACTIVATION'
        ? this.activationHtml(payload, setupUrl)
        : message.template === 'PLATFORM_INVOICE'
        ? this.platformInvoiceHtml(payload)
        : message.template === 'TRIAL_EXPIRING'
        ? this.trialExpiringHtml(payload, `${publicWebUrl}/brand-manager/plan`)
        : message.template === 'REGISTRATION_APPLICATION_REJECTED'
        ? this.registrationRejectedHtml(payload)
        : message.template === 'SUBSCRIPTION_NOTICE'
        ? this.subscriptionNoticeHtml(payload, `${publicWebUrl}/brand-manager/plan`)
        : this.setupHtml(payload, setupUrl);
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
          html,
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

  private activationHtml(payload: SetupPayload, activationUrl: string): string {
    const business = this.escape(payload.businessName ?? 'doanh nghiệp');
    const plan = this.escape(payload.planName ?? 'gói đã duyệt');
    const expiry = payload.expiresAt ? new Date(payload.expiresAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '';
    return `<p>Hồ sơ ${business} đã được duyệt với ${plan}.</p><p><a href="${this.escape(activationUrl)}">Chọn dùng thử hoặc thanh toán để kích hoạt</a></p><p>Liên kết chỉ dùng một lần${expiry ? `, hết hạn lúc ${this.escape(expiry)}` : ''}. Tài khoản Brand Manager được cấp sau khi kích hoạt.</p>`;
  }

  private platformInvoiceHtml(payload: SetupPayload): string {
    const amount = Number(payload.amount ?? 0).toLocaleString('vi-VN');
    return `<p>Hóa đơn thuê bao Smart F&B: ${this.escape(amount)} ₫.</p><p><a href="${this.escape(payload.checkoutUrl ?? '')}">Thanh toán qua PayOS</a></p><p>Liên kết thanh toán có thời hạn 15 phút. Hệ thống chỉ gia hạn khi PayOS xác nhận đúng số tiền.</p>`;
  }

  private registrationRejectedHtml(payload: SetupPayload): string {
    return `<p>Xin chào ${this.escape(payload.representativeName ?? '')},</p><p>Hồ sơ đăng ký ${this.escape(payload.businessName ?? 'doanh nghiệp')} chưa được chấp thuận.</p><p>Lý do: ${this.escape(payload.rejectionReason ?? '')}</p><p>Vui lòng liên hệ bộ phận hỗ trợ nếu cần thêm thông tin.</p>`;
  }

  private trialExpiringHtml(payload: SetupPayload, planUrl: string): string {
    const business = this.escape(payload.businessName ?? 'doanh nghiệp của bạn');
    const days = payload.daysRemaining ?? 0;
    const expiry = payload.trialEndsAt
      ? new Date(payload.trialEndsAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
      : '';
    return `<p>Xin chào,</p><p>Gói dùng thử SmartFnB của ${business} còn ${days} ngày${expiry ? `, hết hạn lúc ${this.escape(expiry)}` : ''}.</p><p>Bạn có thể <a href="${this.escape(planUrl)}">xem và nâng cấp gói ngay</a>; không cần đợi hết 14 ngày. Gói trả phí chỉ bắt đầu khi thanh toán được xác nhận.</p><p>Nếu không nâng cấp, dữ liệu vẫn được giữ nhưng doanh nghiệp sẽ chuyển sang chế độ chỉ đọc khi hết hạn.</p>`;
  }

  /** Reminders, receipts and registration confirmations (25.5): platform branding, no QR or secrets. */
  private subscriptionNoticeHtml(payload: SetupPayload, planUrl: string): string {
    const lines = (payload.lines ?? [])
      .map((line) => `<tr><td>${this.escape(line.description)}</td><td>× ${line.quantity}</td><td style="text-align:right">${Number(line.amount).toLocaleString('vi-VN')}đ</td></tr>`)
      .join('');
    const table = lines
      ? `<table cellpadding="4">${lines}${payload.total !== undefined ? `<tr><td colspan="2"><strong>Tổng</strong></td><td style="text-align:right"><strong>${Number(payload.total).toLocaleString('vi-VN')}đ</strong></td></tr>` : ''}</table>`
      : '';
    const paragraphs = (payload.paragraphs ?? []).map((text) => `<p>${this.escape(text)}</p>`).join('');
    return `<p><strong>Smart F&amp;B</strong></p><h3>${this.escape(payload.heading ?? 'Thông báo thuê bao')}</h3>${paragraphs}${table}<p><a href="${this.escape(planUrl)}">Mở trang Gói dịch vụ</a></p>`;
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
