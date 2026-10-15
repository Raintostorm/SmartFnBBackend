import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ReceiptPdfService } from '../dist/modules/receipt-documents/receipt-pdf.service.js';

const money = (value) => ({ toString: () => String(value) });

describe('Cashier archived receipt PDF', () => {
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
