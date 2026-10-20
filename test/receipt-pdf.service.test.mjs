import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ReceiptPdfService } from '../dist/modules/receipt-documents/receipt-pdf.service.js';

const money = (value) => ({ toString: () => String(value) });
const require = createRequire(import.meta.url);
const fontkit = createRequire(require.resolve('pdfkit'))('fontkit');

describe('Cashier archived receipt PDF', () => {
  it('embeds complete regular and bold fonts with Latin, Vietnamese, digits, and đồng glyphs', () => {
    for (const weight of ['Regular', 'Bold']) {
      const path = fileURLToPath(new URL(`../assets/fonts/HarmonyOS_Sans_${weight}.ttf`, import.meta.url));
      const font = fontkit.openSync(path);
      for (const character of 'Smart FnB Cà phê Trà sữa 123.000 ₫ Độ') {
        assert.ok(font.hasGlyphForCodePoint(character.codePointAt(0)), `${weight}: missing ${character}`);
      }
    }
  });

  it('renders a non-empty PDF with Vietnamese receipt data and tracking QR', async () => {
    const result = await new ReceiptPdfService().render({
      orderCode: 'CTR-001',
      callNumber: 23,
      paidAt: new Date('2026-10-16T01:00:00.000Z'),
      currency: 'VND',
      seller: {
        name: 'Cà phê Thử Nghiệm',
        branchName: 'Chi nhánh Quận 1',
        address: '1 Nguyễn Huệ, TP.HCM',
        phone: '0900000000',
      },
      cashier: 'Thu Ngân',
      items: [
        {
          itemName: 'Trà sữa',
          quantity: 2,
          unitPrice: money(30000),
          selectedOptions: [{ name: 'Trân châu' }],
          specialInstructions: 'Ít đá',
        },
      ],
      totalAmount: money(60000),
      payment: { method: 'CASH', tenderedAmount: money(100000), changeAmount: money(40000) },
      trackingUrl: 'https://smartfnb.example/t/a-secure-token',
    });

    assert.equal(result.subarray(0, 4).toString(), '%PDF');
    assert.ok(result.length > 5_000);
  });
});
