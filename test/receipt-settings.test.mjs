import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  receiptFooter,
  validateReceiptSettings,
} from '../dist/modules/branch-manager/receipt-settings.js';
import { ReceiptSettingsService } from '../dist/modules/branch-manager/receipt-settings.service.js';

const manager = { id: 'user', role: 'MANAGER', branchId: 'branch', employeeId: 'staff' };

describe('BM-08 receipt settings', () => {
  it('trims values, turns empty strings into null, and keeps omitted fields undefined', () => {
    assert.deepEqual(
      validateReceiptSettings({ wifiName: '  Quan_Wifi ', wifiPassword: '', footerNote: '  ' }),
      { wifiName: 'Quan_Wifi', wifiPassword: null, reviewUrl: undefined, footerNote: null },
    );
  });

  it('accepts https Google Maps review links', () => {
    for (const url of [
      'https://g.page/r/CabcDEF123/review',
      'https://maps.app.goo.gl/AbCdEf123',
      'https://www.google.com/maps/place/Quan+Ca+Phe',
      'https://search.google.com/local/writereview?placeid=ChIJ123',
      'https://www.google.com.vn/maps/place/Quan',
    ]) {
      assert.equal(validateReceiptSettings({ reviewUrl: url }).reviewUrl, new URL(url).href);
    }
  });

  it('rejects non-https, non-Google and malformed review links', () => {
    for (const url of [
      'http://g.page/r/abc/review',
      'https://evil.example/maps',
      'https://google.com.evil.example/maps',
      'not a url',
    ]) {
      assert.throws(() => validateReceiptSettings({ reviewUrl: url }), /reviewUrl/);
    }
  });

  it('rejects wifi passwords the text-mode printer cannot print', () => {
    assert.throws(() => validateReceiptSettings({ wifiPassword: 'mậtkhẩu' }), /ASCII/);
    assert.throws(() => validateReceiptSettings({ wifiPassword: 'a'.repeat(64) }), /63/);
    assert.equal(validateReceiptSettings({ wifiPassword: 'P@ss w0rd!' }).wifiPassword, 'P@ss w0rd!');
  });

  it('maps a missing setting to an empty footer', () => {
    assert.deepEqual(receiptFooter(null), {
      wifiName: null,
      wifiPassword: null,
      reviewUrl: null,
      note: null,
    });
  });

  it('upserts the branch row and audits changed field names without the wifi password', async () => {
    let stored = null;
    const audits = [];
    const tx = {
      branchReceiptSetting: {
        findUnique: async () => stored,
        // Giống Prisma: trường `undefined` bị bỏ qua, cột không gửi khi tạo mới là null.
        upsert: async ({ create, update }) => {
          const defined = (data) =>
            Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
          stored = stored
            ? { ...stored, ...defined(update) }
            : { wifiName: null, wifiPassword: null, reviewUrl: null, footerNote: null, ...defined(create) };
          stored.updatedAt = new Date('2026-11-28T00:00:00Z');
          return stored;
        },
      },
      branchAuditLog: { create: async ({ data }) => audits.push(data) },
    };
    const service = new ReceiptSettingsService({ $transaction: async (fn) => fn(tx) });

    const saved = await service.update(manager, {
      wifiName: 'Quan_Wifi',
      wifiPassword: 'secret123',
    });
    assert.equal(saved.branchId, 'branch');
    assert.equal(saved.wifiPassword, 'secret123');
    assert.deepEqual(audits[0].after, { changed: ['wifiName', 'wifiPassword'] });
    assert.ok(!JSON.stringify(audits).includes('secret123'));

    await service.update(manager, { footerNote: 'Hẹn gặp lại!' });
    assert.equal(stored.wifiName, 'Quan_Wifi');
    assert.deepEqual(audits[1].after, { changed: ['footerNote'] });
  });

  it('rejects accounts that are not an assigned Store Manager', async () => {
    const service = new ReceiptSettingsService({});
    await assert.rejects(() => service.get({ id: 'u', role: 'CASHIER', branchId: 'branch' }));
  });
});
