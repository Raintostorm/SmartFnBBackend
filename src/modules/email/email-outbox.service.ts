import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { EmailOutboxStatus, type Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  LOGO_CONTENT_ID,
  emailLogoBase64,
  escapeHtml,
  formatVnDateTime,
  formatVnd,
  lineItemsTable,
  renderEmailLayout,
  withEmailFonts,
  EMAIL_FONT,
  type EmailDetail,
} from './email-layout.js';

/** Human-readable role labels shown in the email eyebrow. */
const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Quản trị nền tảng',
  PLATFORM_STAFF: 'Platform Staff',
  OWNER: 'Brand Manager',
  MANAGER: 'Quản lý chi nhánh',
  CASHIER: 'Thu ngân',
  BARISTA: 'Pha chế',
};

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
  setupTokenEncrypted?: string;
  setupPath?: string;
  expiresAt?: string;
  heading?: string;
  paragraphs?: string[];
  lines?: Array<{ description: string; quantity: number; amount: number }>;
  total?: number;
  selfReset?: boolean;
  loginEmail?: string;
  applicationCode?: string;
};

@Injectable()
export class EmailOutboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Keep only authenticated ciphertext in the durable queue; old queued rows remain readable. */
  sealSetupToken(token: string): string {
    const key = createHash('sha256').update(this.config.getOrThrow<string>('JWT_REFRESH_SECRET')).digest();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
  }

  readSetupToken(payload: { setupToken?: unknown; setupTokenEncrypted?: unknown }): string | null {
    if (typeof payload.setupTokenEncrypted === 'string') {
      const bytes = Buffer.from(payload.setupTokenEncrypted, 'base64url');
      const key = createHash('sha256').update(this.config.getOrThrow<string>('JWT_REFRESH_SECRET')).digest();
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    }
    return typeof payload.setupToken === 'string' ? payload.setupToken : null;
  }

  async deliver(id: string): Promise<EmailOutboxStatus> {
    const message = await this.prisma.emailOutbox.findUnique({ where: { id } });
    if (!message || message.status === EmailOutboxStatus.SENT) {
      return message?.status ?? EmailOutboxStatus.FAILED;
    }
    const accountEmail = ['OWNER_ACCOUNT_CREATED', 'STAFF_ACCOUNT_CREATED', 'PASSWORD_RESET', 'SELF_PASSWORD_RESET', 'PLATFORM_STAFF_INVITATION', 'PLATFORM_STAFF_PASSWORD_RESET', 'OWNER_PASSWORD_RESET'].includes(message.template);
    if (accountEmail) await this.recordAccountEmail(message.recipient, message.template, EmailOutboxStatus.PENDING);
    const apiKey = this.config.get<string>('EMAIL_API_KEY')?.trim();
    const from = this.config.get<string>('EMAIL_FROM')?.trim();
    if (!apiKey || !from) return EmailOutboxStatus.PENDING;

    const payload = message.payload as SetupPayload;
    const publicWebUrl = this.config.get<string>('PUBLIC_WEB_URL')!.replace(/\/+$/, '');
    const setupPath = `/${String(payload.setupPath ?? '/setup-password').replace(/^\/+/, '')}`;
    const setupUrl = `${publicWebUrl}${setupPath}?token=${encodeURIComponent(this.readSetupToken(payload) ?? '')}`;
    const logo = emailLogoBase64();
    const hasLogo = logo !== null;
    const body =
      message.template === 'REGISTRATION_ACTIVATION'
        ? this.activationHtml(payload, setupUrl, hasLogo)
        : message.template === 'PLATFORM_INVOICE'
        ? this.platformInvoiceHtml(payload, hasLogo)
        : message.template === 'TRIAL_EXPIRING'
        ? this.trialExpiringHtml(payload, `${publicWebUrl}/brand-manager/plan`, hasLogo)
        : message.template === 'REGISTRATION_APPLICATION_REJECTED'
        ? this.registrationRejectedHtml(payload, hasLogo)
        : message.template === 'SUBSCRIPTION_NOTICE'
        ? this.subscriptionNoticeHtml(payload, `${publicWebUrl}/brand-manager/plan`, hasLogo)
        : this.setupHtml(message.template, payload, setupUrl, hasLogo);
    const html = withEmailFonts(body, publicWebUrl);
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
          ...(logo ? { attachments: [{ filename: 'smartfnb-logo.png', content: logo, content_type: 'image/png', content_id: LOGO_CONTENT_ID }] } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Email provider rejected the request (${response.status}) ${body}`.trim());
      }
    } catch (error) {
      await this.prisma.emailOutbox.update({
        where: { id },
        data: {
          status: EmailOutboxStatus.FAILED,
          attempts: { increment: 1 },
          lastError: String(error instanceof Error ? error.message : error).slice(0, 1000),
        },
      });
      if (accountEmail) await this.recordAccountEmail(message.recipient, message.template, EmailOutboxStatus.FAILED);
      return EmailOutboxStatus.FAILED;
    }
    const sentAt = new Date();
    await this.prisma.emailOutbox.update({
      where: { id },
      data: {
        status: EmailOutboxStatus.SENT,
        payload: (({ setupToken: _removed, setupTokenEncrypted: _sealed, ...rest }) => rest)(payload) as Prisma.InputJsonValue,
        attempts: { increment: 1 },
        lastError: null,
        sentAt,
      },
    });
    if (message.template === 'REGISTRATION_ACTIVATION') {
      const token = this.readSetupToken(payload);
      if (token) {
        await this.prisma.registrationApplication.updateMany({
          where: { activationTokenHash: createHash('sha256').update(token).digest('hex'), status: 'APPROVED' },
          data: { activationSentAt: sentAt },
        });
      }
    }
    if (accountEmail) await this.recordAccountEmail(message.recipient, message.template, EmailOutboxStatus.SENT);
    return EmailOutboxStatus.SENT;
  }

  private async recordAccountEmail(recipient: string, template: string, status: EmailOutboxStatus) {
    await this.prisma.user.updateMany({ where: { email: recipient, deletedAt: null }, data: { emailSendStatus: status, ...(status === EmailOutboxStatus.SENT ? { emailSentAt: new Date() } : {}) } });
    if (status !== EmailOutboxStatus.PENDING && ['PASSWORD_RESET', 'SELF_PASSWORD_RESET', 'PLATFORM_STAFF_PASSWORD_RESET', 'OWNER_PASSWORD_RESET'].includes(template)) {
      const user = await this.prisma.user.findFirst({ where: { email: recipient, deletedAt: null }, select: { id: true } });
      if (user) await this.prisma.passwordResetAudit.create({ data: { event: status === EmailOutboxStatus.SENT ? 'EMAIL_SENT' : 'EMAIL_FAILED', subjectUserId: user.id } });
    }
  }

  /** Account setup / password emails, tailored to the recipient's role and the reason for the link. */
  private setupHtml(template: string, payload: SetupPayload, setupUrl: string, hasLogo: boolean): string {
    const name = payload.employeeName?.trim() || 'bạn';
    const expiresAt = formatVnDateTime(payload.expiresAt);
    const details: EmailDetail[] = [];
    let eyebrow = 'Bảo mật tài khoản';
    let title = 'Đặt mật khẩu mới';
    let preheader = 'Liên kết đặt mật khẩu Smart F&B của bạn.';
    let paragraphs: string[];
    let cta = 'Đặt mật khẩu mới';
    let safety = 'Nếu bạn không yêu cầu thay đổi này, hãy bỏ qua email và liên hệ quản lý của bạn.';

    if (payload.selfReset || template === 'SELF_PASSWORD_RESET') {
      title = 'Yêu cầu đặt lại mật khẩu';
      preheader = 'Bạn vừa yêu cầu đặt lại mật khẩu Smart F&B.';
      paragraphs = ['Chúng tôi đã nhận được yêu cầu đặt lại mật khẩu cho tài khoản Smart F&B của bạn. Nhấn nút bên dưới để tạo mật khẩu mới.'];
      safety = 'Nếu không phải bạn yêu cầu, hãy bỏ qua email này. Mật khẩu hiện tại của bạn vẫn sử dụng được.';
    } else if (template === 'OWNER_ACCOUNT_CREATED') {
      eyebrow = ROLE_LABEL.OWNER;
      title = 'Chào mừng bạn đến với Smart F&B';
      preheader = 'Tài khoản Brand Manager của bạn đã sẵn sàng.';
      paragraphs = [
        `Doanh nghiệp ${payload.businessName ?? 'của bạn'} đã được kích hoạt thành công trên Smart F&B Platform.`,
        'Tài khoản Brand Manager đã được tạo để bạn quản lý thương hiệu, chi nhánh, thực đơn và đội ngũ. Hãy thiết lập mật khẩu để đăng nhập lần đầu.',
      ];
      if (payload.businessName) details.push({ label: 'Doanh nghiệp', value: payload.businessName });
      if (payload.loginEmail) details.push({ label: 'Email đăng nhập', value: payload.loginEmail });
      details.push({ label: 'Vai trò', value: ROLE_LABEL.OWNER });
      cta = 'Thiết lập mật khẩu';
      safety = 'Nếu bạn không đăng ký doanh nghiệp trên Smart F&B, hãy bỏ qua email này.';
    } else if (template === 'STAFF_ACCOUNT_CREATED') {
      const role = ROLE_LABEL[payload.role ?? ''] ?? 'Nhân viên';
      eyebrow = role;
      title = 'Bạn đã được thêm vào đội ngũ';
      preheader = `Tài khoản ${role}${payload.branchName ? ` tại ${payload.branchName}` : ''} đã được tạo.`;
      paragraphs = [
        `Tài khoản Smart F&B với vai trò ${role}${payload.branchName ? ` tại ${payload.branchName}` : ''} đã được tạo cho bạn.`,
        'Hãy thiết lập mật khẩu để bắt đầu sử dụng hệ thống.',
      ];
      details.push({ label: 'Vai trò', value: role });
      if (payload.branchName) details.push({ label: 'Chi nhánh', value: payload.branchName });
      cta = 'Thiết lập mật khẩu';
      safety = 'Nếu bạn không làm việc tại đơn vị này, hãy bỏ qua email.';
    } else if (template === 'PLATFORM_STAFF_INVITATION') {
      eyebrow = ROLE_LABEL.PLATFORM_STAFF;
      title = 'Lời mời tham gia đội vận hành';
      preheader = 'Bạn được mời làm Platform Staff của Smart F&B.';
      paragraphs = [
        'Bạn được mời tham gia đội vận hành Smart F&B Platform với vai trò Platform Staff.',
        'Hãy thiết lập mật khẩu để kích hoạt tài khoản và truy cập trang quản trị nền tảng.',
      ];
      details.push({ label: 'Vai trò', value: ROLE_LABEL.PLATFORM_STAFF });
      cta = 'Kích hoạt tài khoản';
      safety = 'Nếu bạn không mong đợi lời mời này, hãy bỏ qua email.';
    } else {
      // PASSWORD_RESET, PLATFORM_STAFF_PASSWORD_RESET, OWNER_PASSWORD_RESET: a superior issued a new link.
      if (template === 'PLATFORM_STAFF_PASSWORD_RESET') eyebrow = ROLE_LABEL.PLATFORM_STAFF;
      if (template === 'OWNER_PASSWORD_RESET') eyebrow = ROLE_LABEL.OWNER;
      paragraphs = [
        `Mật khẩu tài khoản Smart F&B${payload.branchName ? ` tại ${payload.branchName}` : ''} của bạn đã được đặt lại theo yêu cầu.`,
        'Nhấn nút bên dưới để tạo mật khẩu mới và tiếp tục đăng nhập.',
      ];
    }

    if (expiresAt) details.push({ label: 'Liên kết hết hạn', value: expiresAt });
    return renderEmailLayout({
      hasLogo,
      preheader,
      eyebrow,
      title,
      greeting: `Xin chào ${name},`,
      paragraphs,
      details,
      cta: { label: cta, url: setupUrl },
      showFallbackLink: true,
      notice: { tone: 'neutral', title: 'Lưu ý bảo mật', text: 'Liên kết chỉ dùng được một lần. Không chia sẻ email này cho bất kỳ ai, kể cả người tự xưng là nhân viên Smart F&B.' },
      footnotes: [safety],
    });
  }

  private activationHtml(payload: SetupPayload, activationUrl: string, hasLogo: boolean): string {
    const business = payload.businessName ?? 'doanh nghiệp của bạn';
    const expiry = formatVnDateTime(payload.expiresAt);
    const details: EmailDetail[] = [{ label: 'Doanh nghiệp', value: business }];
    if (payload.planName) details.push({ label: 'Gói được duyệt', value: payload.planName });
    if (expiry) details.push({ label: 'Liên kết hết hạn', value: expiry });
    return renderEmailLayout({
      hasLogo,
      preheader: `Hồ sơ ${business} đã được duyệt. Kích hoạt doanh nghiệp ngay.`,
      eyebrow: 'Đăng ký doanh nghiệp',
      title: 'Hồ sơ của bạn đã được duyệt',
      greeting: payload.employeeName ? `Xin chào ${payload.employeeName},` : 'Xin chào,',
      paragraphs: [
        `Chúc mừng! Hồ sơ đăng ký của ${business} đã được đội ngũ Smart F&B phê duyệt.`,
        'Bước tiếp theo: chọn dùng thử miễn phí hoặc thanh toán để kích hoạt doanh nghiệp. Tài khoản Brand Manager sẽ được cấp ngay sau khi kích hoạt.',
      ],
      details,
      cta: { label: 'Kích hoạt doanh nghiệp', url: activationUrl },
      showFallbackLink: true,
      footnotes: ['Liên kết kích hoạt chỉ dùng được một lần. Nếu liên kết hết hạn, vui lòng liên hệ bộ phận hỗ trợ để được cấp lại.'],
    });
  }

  private platformInvoiceHtml(payload: SetupPayload, hasLogo: boolean): string {
    const amount = formatVnd(payload.amount);
    const amountHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px"><tr><td align="center" style="padding:22px 16px;border:1px solid #e4e4e7;border-radius:10px;background:#fafafa"><div style="font-family:${EMAIL_FONT};font-size:12px;font-weight:600;letter-spacing:.6px;text-transform:uppercase;color:#6B7280">Số tiền cần thanh toán</div><div style="font-family:${EMAIL_FONT};font-size:30px;font-weight:700;color:#1A1D21;margin-top:6px">${escapeHtml(amount)}</div></td></tr></table>`;
    return renderEmailLayout({
      hasLogo,
      preheader: `Hóa đơn thuê bao Smart F&B: ${amount}.`,
      eyebrow: 'Thuê bao & thanh toán',
      title: 'Hóa đơn gói dịch vụ',
      greeting: 'Xin chào,',
      paragraphs: ['Hóa đơn thuê bao Smart F&B của doanh nghiệp bạn đã sẵn sàng. Vui lòng hoàn tất thanh toán qua PayOS.'],
      extraHtml: amountHtml,
      cta: payload.checkoutUrl ? { label: 'Thanh toán qua PayOS', url: payload.checkoutUrl } : undefined,
      notice: { tone: 'warning', title: 'Thời hạn thanh toán', text: 'Liên kết thanh toán có hiệu lực trong 15 phút. Gói chỉ được gia hạn khi PayOS xác nhận đúng số tiền.' },
    });
  }

  private registrationRejectedHtml(payload: SetupPayload, hasLogo: boolean): string {
    const business = payload.businessName ?? 'doanh nghiệp';
    const details: EmailDetail[] = [{ label: 'Doanh nghiệp', value: business }];
    if (payload.applicationCode) details.push({ label: 'Mã hồ sơ', value: payload.applicationCode });
    return renderEmailLayout({
      hasLogo,
      preheader: `Kết quả xét duyệt hồ sơ đăng ký ${business}.`,
      eyebrow: 'Đăng ký doanh nghiệp',
      title: 'Hồ sơ chưa được chấp thuận',
      greeting: payload.representativeName ? `Xin chào ${payload.representativeName},` : 'Xin chào,',
      paragraphs: [`Cảm ơn bạn đã quan tâm đến Smart F&B. Sau khi xem xét, hồ sơ đăng ký của ${business} hiện chưa được chấp thuận.`],
      details,
      notice: { tone: 'error', title: 'Lý do', text: payload.rejectionReason ?? 'Không có thông tin.' },
      footnotes: ['Bạn có thể bổ sung thông tin và gửi lại hồ sơ, hoặc liên hệ bộ phận hỗ trợ nếu cần giải thích thêm.'],
    });
  }

  private trialExpiringHtml(payload: SetupPayload, planUrl: string, hasLogo: boolean): string {
    const business = payload.businessName ?? 'doanh nghiệp của bạn';
    const days = payload.daysRemaining ?? 0;
    const expiry = formatVnDateTime(payload.trialEndsAt);
    const details: EmailDetail[] = [
      { label: 'Doanh nghiệp', value: business },
      { label: 'Thời gian còn lại', value: `${days} ngày` },
    ];
    if (expiry) details.push({ label: 'Hết hạn dùng thử', value: expiry });
    return renderEmailLayout({
      hasLogo,
      preheader: `Gói dùng thử của ${business} còn ${days} ngày.`,
      eyebrow: ROLE_LABEL.OWNER,
      title: 'Gói dùng thử sắp kết thúc',
      greeting: 'Xin chào,',
      paragraphs: [
        `Gói dùng thử Smart F&B của ${business} còn ${days} ngày.`,
        'Bạn có thể nâng cấp ngay bây giờ mà không cần đợi hết thời gian dùng thử. Gói trả phí chỉ bắt đầu khi thanh toán được xác nhận.',
      ],
      details,
      notice: { tone: 'warning', text: 'Nếu không nâng cấp, dữ liệu vẫn được giữ nguyên nhưng doanh nghiệp sẽ chuyển sang chế độ chỉ đọc khi hết hạn.' },
      cta: { label: 'Xem và nâng cấp gói', url: planUrl },
    });
  }

  /** Reminders, receipts and registration confirmations (25.5): platform branding, no QR or secrets. */
  private subscriptionNoticeHtml(payload: SetupPayload, planUrl: string, hasLogo: boolean): string {
    const heading = payload.heading ?? 'Thông báo thuê bao';
    return renderEmailLayout({
      hasLogo,
      preheader: heading,
      eyebrow: 'Thuê bao & thanh toán',
      title: heading,
      greeting: 'Xin chào,',
      paragraphs: payload.paragraphs ?? [],
      extraHtml: lineItemsTable(payload.lines ?? [], payload.total),
      cta: { label: 'Mở trang Gói dịch vụ', url: planUrl },
    });
  }
}
