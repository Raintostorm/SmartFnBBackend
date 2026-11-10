import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '../dist/generated/prisma/client.js';
import { RefundDocumentsService } from '../dist/modules/receipt-documents/refund-documents.service.js';
import { RefundPdfService, refundReasonText } from '../dist/modules/receipt-documents/refund-pdf.service.js';
import { ReceiptRasterService } from '../dist/modules/receipt-documents/receipt-raster.service.js';

const D = (value) => new Prisma.Decimal(value);
const cashier = { id: 'u-cashier', role: 'CASHIER', employeeId: 'emp-cashier', branchId: 'branch-1' };
const otherBranchCashier = { ...cashier, branchId: 'branch-2' };
const owner = { id: 'u-owner', role: 'OWNER', ownerId: 'owner-1' };
const access = {
  assertCanAccessBranch: async (user, branchId) => {
    if (user.role === 'OWNER') return;
    if (user.branchId !== branchId) throw new ForbiddenException('outside branch');
  },
};

/** One paid QR order with an item (options + topping) and a combo; refunds are frozen rows. */
function world() {
  const items = {
    tea: { id: 'oi-tea', itemName: 'Trà sữa', unitPrice: D(35000), quantity: 2, lineType: 'ITEM', selectedOptions: [{ name: 'Ít đá' }, { kind: 'EXTRA', name: 'Trân châu', quantity: 1 }], children: [] },
    combo: { id: 'oi-combo', itemName: 'Combo sáng', unitPrice: D(55000), quantity: 1, lineType: 'COMBO', selectedOptions: [], children: [{ itemName: 'Cà phê', quantity: 1 }, { itemName: 'Bánh mì', quantity: 1 }] },
  };
  const menu = { 'oi-tea': { price: D(99999), name: 'Tên mới trên menu' } };
  const refunds = [];
  const documents = [];
  const printLogs = [];
  const order = {
    id: 'order-1', orderCode: 'CTR-001', callNumber: 7, paidAt: new Date('2026-11-10T02:00:00Z'), branchId: 'branch-1',
    branch: { name: 'Quận 1', addressLine1: '1 Lê Lợi', addressLine2: null, ward: null, district: 'Q1', city: 'HCM', phone: '0900', chainId: 'chain-1', chain: { name: 'Chuỗi A', currency: 'VND', branding: { displayName: 'Cà phê A' } } },
    refunds,
  };
  const addRefund = (id, lines, amount, at) => {
    refunds.push({
      id, orderId: order.id, paymentId: 'pay-1', amount: D(amount), reason: 'WRONG_ITEM: pha nhầm', requestedAt: at, completedAt: at,
      requestedByEmployeeId: 'emp-cashier', completedByEmployeeId: 'emp-cashier', requestedByRole: 'CASHIER', completedByRole: 'CASHIER',
      items: lines.map((line, index) => ({ id: `${id}-i${index}`, orderItemId: line.id, quantity: line.quantity, refundAmount: D(Number(line.unitPrice) * line.quantity), orderItem: line })),
      payment: { method: 'BANK_TRANSFER', provider: 'PAYOS', amount: D(125000), receivedAmount: D(125000) },
    });
  };
  const doc = (where) => documents.find((row) => (where.refundId ? row.refundId === where.refundId : row.id === where.id)) ?? null;
  const prisma = {
    refund: {
      findUnique: async ({ where, select }) => {
        const refund = refunds.find((row) => row.id === where.id);
        if (!refund) return null;
        return select ? { id: refund.id, orderId: refund.orderId, order: { branchId: order.branchId } } : { ...refund, order };
      },
      findFirst: async ({ where }) => {
        const refund = refunds.find((row) => row.id === where.id && row.orderId === where.orderId);
        return refund ? { id: refund.id, orderId: refund.orderId, order: { branchId: order.branchId } } : null;
      },
    },
    refundDocument: {
      upsert: async ({ where, create }) => {
        const found = doc(where);
        if (found) return found;
        const row = { id: `doc-${documents.length + 1}`, status: 'PENDING', attempts: 0, generationStartedAt: null, storageKey: null, ...create };
        documents.push(row);
        return row;
      },
      findUnique: async ({ where }) => doc(where),
      findUniqueOrThrow: async ({ where }) => doc(where),
      update: async ({ where, data }) => Object.assign(doc(where), data),
      updateMany: async ({ where, data }) => {
        const row = doc(where);
        if (!row) return { count: 0 };
        if (where.status?.not && row.status === where.status.not) return { count: 0 };
        if (where.OR && !where.OR.some((cond) =>
          (cond.generationStartedAt === null && row.generationStartedAt === null) ||
          (cond.generationStartedAt?.lt && row.generationStartedAt && row.generationStartedAt < cond.generationStartedAt.lt) ||
          (cond.status && row.status === cond.status))) return { count: 0 };
        const { attempts, ...rest } = data;
        Object.assign(row, rest);
        if (attempts?.increment) row.attempts += attempts.increment;
        return { count: 1 };
      },
    },
    // The original bill PDF is never read, regenerated or rewritten by a refund (BR-86).
    receiptDocument: new Proxy({}, { get: () => { throw new Error('bill PDF must not be touched'); } }),
    employee: { findUnique: async () => ({ firstName: 'Thu', lastName: 'Ngân' }) },
    refundApprovalRequest: { findFirst: async () => null },
    refundPrintLog: {
      create: async ({ data }) => { const row = { id: `print-${printLogs.length + 1}`, status: 'PENDING', ...data }; printLogs.push(row); return row; },
      count: async ({ where }) => printLogs.filter((row) => row.refundId === where.refundId && row.isReprint === where.isReprint).length,
      findMany: async () => printLogs,
      findUnique: async ({ where }) => printLogs.find((row) => row.id === where.id) ?? null,
      findUniqueOrThrow: async ({ where }) => printLogs.find((row) => row.id === where.id),
      updateMany: async ({ where, data }) => {
        const row = printLogs.find((item) => item.id === where.id && item.status === where.status);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  };
  const files = new Map();
  const storage = {
    failNext: false,
    put: async (key, data) => {
      if (storage.failNext) { storage.failNext = false; throw new Error('R2 unavailable'); }
      files.set(key, Buffer.from(data));
    },
    read: async (key) => files.get(key),
    access: async (key, orderId, path) => ({ downloadUrl: path, expiresAt: null }),
  };
  const pdf = new RefundPdfService();
  let renders = 0;
  const countingPdf = { render: async (slip) => { renders++; return pdf.render(slip); } };
  const service = new RefundDocumentsService(prisma, access, countingPdf, new ReceiptRasterService(), storage, { get: (_k, fallback) => fallback });
  return { service, items, menu, refunds, documents, printLogs, files, storage, addRefund, renders: () => renders };
}

describe('Refund slip PDF (BR-86, 28.6)', () => {
  it('renders a 58 mm PDF whose bytes depend only on the frozen refund', async () => {
    const w = world();
    w.addRefund('r1', [w.items.tea], 70000, new Date('2026-11-10T03:00:00Z'));
    const { slip } = await w.service.snapshot('r1');
    const pdf = new RefundPdfService();
    const [a, b] = await Promise.all([pdf.render(slip), pdf.render(slip)]);
    assert.equal(a.subarray(0, 4).toString(), '%PDF');
    assert.equal(createHash('sha256').update(a).digest('hex'), createHash('sha256').update(b).digest('hex'));
    const png = await new ReceiptRasterService().render(a);
    assert.equal(png.readUInt32BE(16), 768, '58 mm thermal width');
    assert.equal(refundReasonText('WRONG_ITEM: pha nhầm'), 'Món sai – pha nhầm');
  });

  it('builds the slip from order lines at sale price, never from the current menu', async () => {
    const w = world();
    w.addRefund('r1', [w.items.tea, w.items.combo], 125000, new Date('2026-11-10T03:00:00Z'));
    w.menu['oi-tea'].price = D(1); // price changed after the sale
    const { slip } = await w.service.snapshot('r1');
    assert.equal(slip.paidWith, 'QR');
    assert.equal(slip.scope, 'FULL');
    assert.equal(slip.lines[0].itemName, 'Trà sữa');
    assert.equal(slip.lines[0].unitPrice.toString(), '35000');
    assert.deepEqual(slip.lines[1].children.map((c) => c.itemName), ['Cà phê', 'Bánh mì'], 'combo printed as one line with its components');
    assert.equal(slip.totalCollected.toString(), '125000');
    assert.equal(slip.refundedBy, 'Thu Ngân');
  });

  it('creates one PDF per partial refund with cumulative totals, and is idempotent', async () => {
    const w = world();
    w.addRefund('r1', [w.items.combo], 55000, new Date('2026-11-10T03:00:00Z'));
    w.addRefund('r2', [w.items.tea], 70000, new Date('2026-11-10T04:00:00Z'));
    const [d1, d1again, d2] = [await w.service.ensureReady('r1'), await w.service.ensureReady('r1'), await w.service.ensureReady('r2')];
    assert.equal(d1.status, 'READY');
    assert.equal(d1again.id, d1.id);
    assert.equal(w.renders(), 2, 'the repeated call did not render again');
    assert.equal(w.documents.length, 2);
    assert.notEqual(d1.storageKey, d2.storageKey);
    assert.equal(w.files.size, 2);
    const s1 = (await w.service.snapshot('r1')).slip;
    const s2 = (await w.service.snapshot('r2')).slip;
    assert.equal(s1.scope, 'PARTIAL');
    assert.equal(s1.totalRefunded.toString(), '55000');
    assert.equal(s2.scope, 'FULL');
    assert.equal(s2.totalRefunded.toString(), '125000');
    const before = d1.checksum;
    await w.service.get(cashier, 'order-1', 'r1');
    assert.equal(w.documents[0].checksum, before, 'reading never regenerates a READY PDF');
  });

  it('marks FAILED without touching the refund, then retries into the same document', async () => {
    const w = world();
    w.addRefund('r1', [w.items.tea], 70000, new Date('2026-11-10T03:00:00Z'));
    w.storage.failNext = true;
    const failed = await w.service.ensureReady('r1');
    assert.equal(failed.status, 'FAILED');
    assert.match(failed.errorMessage, /R2 unavailable/);
    assert.equal(w.refunds.length, 1);
    const retried = await w.service.retry(cashier, 'order-1', 'r1');
    assert.equal(retried.status, 'READY');
    assert.equal(w.documents.length, 1, 'retry reuses the single document row');
    assert.equal(w.refunds.length, 1);
    assert.equal(retried.storageKey, undefined, 'storage key never leaves the backend');
    assert.match(retried.downloadUrl, /\/refunds\/r1\/document\/download$/);
    assert.match(retried.printImageUrl, /\/document\/print-image$/);
  });

  it('serves the PNG and the PDF from the stored file within the caller scope only', async () => {
    const w = world();
    w.addRefund('r1', [w.items.tea], 70000, new Date('2026-11-10T03:00:00Z'));
    const image = await w.service.printImage(cashier, 'order-1', 'r1');
    assert.deepEqual([...image.data.subarray(1, 4)].map((c) => String.fromCharCode(c)).join(''), 'PNG');
    const file = await w.service.download(owner, 'order-1', 'r1');
    assert.equal(file.data.subarray(0, 4).toString(), '%PDF');
    await assert.rejects(w.service.get(otherBranchCashier, 'order-1', 'r1'), (error) => error.getStatus() === 403);
    await assert.rejects(w.service.get({ ...cashier, role: 'BARISTA' }, 'order-1', 'r1'), (error) => error.getStatus() === 403);
    await assert.rejects(w.service.get(cashier, 'other-order', 'r1'), (error) => error.getStatus() === 404);
  });

  it('logs reprints with a reason and records printer results without changing the refund', async () => {
    const w = world();
    w.addRefund('r1', [w.items.tea], 70000, new Date('2026-11-10T03:00:00Z'));
    await assert.rejects(w.service.recordPrint(cashier, 'order-1', 'r1', { reason: 'ab' }), (error) => error.getStatus() === 400);
    const { printLog, reprintCount } = await w.service.recordPrint(cashier, 'order-1', 'r1', { reason: 'Khách xin lại phiếu' });
    assert.equal(reprintCount, 1);
    assert.equal(printLog.printedByUserId, cashier.id);
    const failed = await w.service.reportPrintResult(cashier, printLog.id, { status: 'FAILED', errorMessage: 'Hết giấy' });
    assert.equal(failed.status, 'FAILED');
    const again = await w.service.reportPrintResult(cashier, printLog.id, { status: 'PRINTED' });
    assert.equal(again.status, 'FAILED', 'the first reported outcome is final');
    await assert.rejects(w.service.reportPrintResult(otherBranchCashier, printLog.id, { status: 'PRINTED' }), (error) => error.getStatus() === 403);
    assert.equal(w.refunds[0].amount.toString(), '70000');
  });
});
