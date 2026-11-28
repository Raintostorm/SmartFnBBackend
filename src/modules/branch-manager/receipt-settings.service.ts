import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { managerActor, writeBranchAudit } from './manager-scope.js';
import { validateReceiptSettings, type ReceiptSettingsInput } from './receipt-settings.js';

const FIELDS = ['wifiName', 'wifiPassword', 'reviewUrl', 'footerNote'] as const;

@Injectable()
export class ReceiptSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(user: AuthenticatedUser) {
    const { branchId } = managerActor(user);
    const setting = await this.prisma.branchReceiptSetting.findUnique({ where: { branchId } });
    return this.present(branchId, setting);
  }

  async update(user: AuthenticatedUser, input: ReceiptSettingsInput) {
    const actor = managerActor(user);
    const data = validateReceiptSettings(input);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.branchReceiptSetting.findUnique({
        where: { branchId: actor.branchId },
      });
      const setting = await tx.branchReceiptSetting.upsert({
        where: { branchId: actor.branchId },
        create: { branchId: actor.branchId, ...data },
        update: data,
      });
      const changed = FIELDS.filter(
        (field) => (before?.[field] ?? null) !== (setting[field] ?? null),
      );
      if (changed.length) {
        // Chỉ ghi tên trường đã đổi: nhật ký chi nhánh không lưu mật khẩu, kể cả mật khẩu wifi.
        await writeBranchAudit(tx, user, {
          action: 'RECEIPT_SETTINGS_UPDATED',
          entityType: 'BRANCH_RECEIPT_SETTING',
          entityId: actor.branchId,
          after: { changed: [...changed] },
        });
      }
      return this.present(actor.branchId, setting);
    });
  }

  private present(
    branchId: string,
    setting: {
      wifiName: string | null;
      wifiPassword: string | null;
      reviewUrl: string | null;
      footerNote: string | null;
      updatedAt: Date;
    } | null,
  ) {
    return {
      branchId,
      wifiName: setting?.wifiName ?? null,
      wifiPassword: setting?.wifiPassword ?? null,
      reviewUrl: setting?.reviewUrl ?? null,
      footerNote: setting?.footerNote ?? null,
      updatedAt: setting?.updatedAt ?? null,
    };
  }
}
