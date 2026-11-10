import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { PaymentMethod, PaymentProvider, PrintJobStatus, Prisma, ReceiptDocumentStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AppRole } from '../auth/app-role.enum.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import { ReceiptRasterService } from './receipt-raster.service.js';
import { ReceiptStorageService } from './receipt-storage.service.js';
import { RefundPdfService, type RefundPdfSnapshot } from './refund-pdf.service.js';

/** A generator that has not finished in this time is considered dead; another call may take over. */
const STALE_GENERATION_MS = 2 * 60_000;
/** POS waits at most this long in the refund response; afterwards it polls `GET …/document`. */
const INLINE_GENERATION_TIMEOUT_MS = 4_000;

type DocumentRow = Prisma.RefundDocumentGetPayload<object>;

/**
 * Refund slip PDF (BR-86, 28.5–28.6): exactly one immutable PDF per refund, generated after the refund
 * transaction committed, stored like the bill PDF (local in dev, S3/R2 in production). A failure only
 * marks the document FAILED; the refund itself is never touched.
 */
@Injectable()
export class RefundDocumentsService {
  private readonly logger = new Logger(RefundDocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BranchAccessService,
    private readonly pdf: RefundPdfService,
    private readonly raster: ReceiptRasterService,
    private readonly storage: ReceiptStorageService,
    private readonly config: ConfigService,
  ) {}

  private enabled() {
    return this.config.get<boolean>('RECEIPT_PDF_ENABLED', true);
  }

  /**
   * Hook for the refund flows. Never throws: waits a few seconds so the POS usually gets READY in the
   * refund response, otherwise generation continues in the background and the client polls.
   */
  async generateAfterCommit(refundId: string): Promise<{ id: string | null; status: string }> {
    if (!this.enabled()) return { id: null, status: 'DISABLED' };
    const work = this.ensureReady(refundId).catch((error) => {
      this.logger.error(`Refund PDF for ${refundId} failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    const timeout = new Promise<'TIMEOUT'>((resolve) => setTimeout(() => resolve('TIMEOUT'), INLINE_GENERATION_TIMEOUT_MS).unref());
    const outcome = await Promise.race([work, timeout]);
    if (outcome === 'TIMEOUT') return { id: null, status: ReceiptDocumentStatus.PENDING };
    return outcome ? { id: outcome.id, status: outcome.status } : { id: null, status: ReceiptDocumentStatus.FAILED };
  }

  /** Idempotent: a READY document is returned as is; concurrent callers never render twice. */
  async ensureReady(refundId: string): Promise<DocumentRow | null> {
    if (!this.enabled()) return null;
    const refund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      select: { id: true, orderId: true, order: { select: { branchId: true } } },
    });
    if (!refund) throw new NotFoundException('Refund not found');
    const document = await this.upsert(refund.id, refund.orderId, refund.order.branchId);
    if (document.status === ReceiptDocumentStatus.READY) return document;
    const now = new Date();
    const claimed = await this.prisma.refundDocument.updateMany({
      where: {
        id: document.id,
        status: { not: ReceiptDocumentStatus.READY },
        OR: [{ generationStartedAt: null }, { generationStartedAt: { lt: new Date(now.getTime() - STALE_GENERATION_MS) } }],
      },
      data: { generationStartedAt: now, attempts: { increment: 1 }, status: ReceiptDocumentStatus.PENDING },
    });
    if (!claimed.count) return this.prisma.refundDocument.findUniqueOrThrow({ where: { id: document.id } });
    try {
      const snapshot = await this.snapshot(refund.id);
      const data = await this.pdf.render(snapshot.slip);
      const checksum = createHash('sha256').update(data).digest('hex');
      const storageKey = `${snapshot.chainId}/${snapshot.branchId}/${refund.orderId}/refunds/${refund.id}-${checksum.slice(0, 12)}.pdf`;
      await this.storage.put(storageKey, data);
      return await this.prisma.refundDocument.update({
        where: { id: document.id },
        data: {
          status: ReceiptDocumentStatus.READY,
          storageKey,
          fileName: `refund-${this.safe(snapshot.slip.orderCode)}-${refund.id.slice(0, 8)}.pdf`,
          mimeType: 'application/pdf',
          fileSize: data.length,
          checksum,
          generatedAt: new Date(),
          generationStartedAt: null,
          errorMessage: null,
        },
      });
    } catch (error) {
      await this.prisma.refundDocument.updateMany({
        where: { id: document.id, status: { not: ReceiptDocumentStatus.READY } },
        data: {
          status: ReceiptDocumentStatus.FAILED,
          generationStartedAt: null,
          errorMessage: String(error instanceof Error ? error.message : error).slice(0, 1000),
        },
      });
      return this.prisma.refundDocument.findUniqueOrThrow({ where: { id: document.id } });
    }
  }

  async get(user: AuthenticatedUser, orderId: string, refundId: string) {
    const refund = await this.scopedRefund(user, orderId, refundId);
    if (!this.enabled()) return { status: 'DISABLED', refundId: refund.id, orderId };
    // Refunds made before this feature existed get their PDF on first view.
    const document = (await this.prisma.refundDocument.findUnique({ where: { refundId } })) ?? (await this.ensureReady(refundId));
    if (!document) return { status: 'DISABLED', refundId, orderId };
    return this.view(document, orderId);
  }

  async retry(user: AuthenticatedUser, orderId: string, refundId: string) {
    await this.scopedRefund(user, orderId, refundId);
    const document = await this.prisma.refundDocument.findUnique({ where: { refundId } });
    if (document && document.status !== ReceiptDocumentStatus.READY) {
      // Only a failed or abandoned generation is reset; a live one keeps its claim.
      await this.prisma.refundDocument.updateMany({
        where: {
          id: document.id,
          OR: [
            { status: ReceiptDocumentStatus.FAILED },
            { generationStartedAt: null },
            { generationStartedAt: { lt: new Date(Date.now() - STALE_GENERATION_MS) } },
          ],
        },
        data: { status: ReceiptDocumentStatus.PENDING, generationStartedAt: null, errorMessage: null },
      });
    }
    if (document?.status !== ReceiptDocumentStatus.READY) await this.ensureReady(refundId);
    return this.get(user, orderId, refundId);
  }

  async download(user: AuthenticatedUser, orderId: string, refundId: string) {
    await this.scopedRefund(user, orderId, refundId);
    const document = await this.ready(refundId);
    return { data: await this.storage.read(document.storageKey!), fileName: document.fileName ?? `refund-${refundId}.pdf` };
  }

  /** PNG rendered from the stored PDF bytes (same pipeline as the bill), for the thermal printer. */
  async printImage(user: AuthenticatedUser, orderId: string, refundId: string) {
    await this.scopedRefund(user, orderId, refundId);
    let document = await this.prisma.refundDocument.findUnique({ where: { refundId } });
    if (document?.status !== ReceiptDocumentStatus.READY) document = await this.ensureReady(refundId);
    if (!document || document.status !== ReceiptDocumentStatus.READY || !document.storageKey) {
      throw new NotFoundException('Refund PDF is not ready');
    }
    return { data: await this.raster.render(await this.storage.read(document.storageKey)) };
  }

  // ------------------------------------------------------------- print / reprint log (BR-53)

  /** Records one print of the refund slip; reprints need a reason (≥ 3 characters). */
  async recordPrint(user: AuthenticatedUser, orderId: string, refundId: string, dto: { reason?: string; isReprint?: boolean }) {
    const refund = await this.scopedRefund(user, orderId, refundId);
    const isReprint = dto.isReprint ?? true;
    const reason = dto.reason?.trim() ?? '';
    if (isReprint && reason.length < 3) throw new BadRequestException('A reprint reason of at least 3 characters is required');
    const log = await this.prisma.refundPrintLog.create({
      data: {
        refundId,
        branchId: refund.order.branchId,
        printedByUserId: user.id,
        printedByEmployeeId: user.employeeId ?? null,
        printedByRole: user.role,
        isReprint,
        reason: reason || null,
      },
    });
    return { printLog: log, reprintCount: await this.prisma.refundPrintLog.count({ where: { refundId, isReprint: true } }) };
  }

  async listPrints(user: AuthenticatedUser, orderId: string, refundId: string) {
    await this.scopedRefund(user, orderId, refundId);
    return this.prisma.refundPrintLog.findMany({ where: { refundId }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  /** Printer outcome reported by the POS. Only the print log changes — never the refund. */
  async reportPrintResult(user: AuthenticatedUser, printLogId: string, dto: { status: 'PRINTED' | 'FAILED'; errorMessage?: string }) {
    const log = await this.prisma.refundPrintLog.findUnique({ where: { id: printLogId } });
    if (!log) throw new NotFoundException('Refund print log not found');
    this.assertRole(user);
    await this.access.assertCanAccessBranch(user, log.branchId);
    if (log.status !== PrintJobStatus.PENDING) return log;
    await this.prisma.refundPrintLog.updateMany({
      where: { id: log.id, status: PrintJobStatus.PENDING },
      data: {
        status: dto.status === 'PRINTED' ? PrintJobStatus.PRINTED : PrintJobStatus.FAILED,
        printedAt: dto.status === 'PRINTED' ? new Date() : null,
        errorMessage: dto.status === 'FAILED' ? (dto.errorMessage?.trim().slice(0, 500) || 'Printer error') : null,
      },
    });
    return this.prisma.refundPrintLog.findUniqueOrThrow({ where: { id: log.id } });
  }

  // ------------------------------------------------------------- internals

  private assertRole(user: AuthenticatedUser) {
    if (![AppRole.OWNER, AppRole.MANAGER, AppRole.CASHIER].includes(user.role)) {
      throw new ForbiddenException('Cashier, Store Manager or Brand Manager required');
    }
  }

  /** Cashier/Store Manager: own branch; Brand Manager: any branch of an assigned chain. */
  private async scopedRefund(user: AuthenticatedUser, orderId: string, refundId: string) {
    this.assertRole(user);
    const refund = await this.prisma.refund.findFirst({
      where: { id: refundId, orderId },
      select: { id: true, orderId: true, order: { select: { branchId: true } } },
    });
    if (!refund) throw new NotFoundException('Refund not found');
    await this.access.assertCanAccessBranch(user, refund.order.branchId);
    return refund;
  }

  private async ready(refundId: string) {
    const document = await this.prisma.refundDocument.findUnique({ where: { refundId } });
    if (!document || document.status !== ReceiptDocumentStatus.READY || !document.storageKey) {
      throw new NotFoundException('Refund PDF is not ready');
    }
    return document;
  }

  private async upsert(refundId: string, orderId: string, branchId: string) {
    try {
      return await this.prisma.refundDocument.upsert({ where: { refundId }, create: { refundId, orderId, branchId }, update: {} });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.prisma.refundDocument.findUniqueOrThrow({ where: { refundId } });
      }
      throw error;
    }
  }

  /** Never exposes the storage key; a signed S3/R2 link lives 10 minutes. */
  private async view(document: DocumentRow, orderId: string) {
    const base = `/api/v1/cashier/orders/${orderId}/refunds/${document.refundId}/document`;
    const link =
      document.status === ReceiptDocumentStatus.READY && document.storageKey
        ? await this.storage.access(document.storageKey, orderId, `${base}/download`)
        : { downloadUrl: null, expiresAt: null };
    return {
      id: document.id,
      refundId: document.refundId,
      orderId,
      status: document.status,
      fileName: document.fileName,
      fileSize: document.fileSize,
      checksum: document.checksum,
      generatedAt: document.generatedAt,
      attempts: document.attempts,
      errorMessage: document.errorMessage,
      printImageUrl: document.status === ReceiptDocumentStatus.READY ? `${base}/print-image` : null,
      ...link,
    };
  }

  /** Frozen data only: order lines carry the name, options and price at sale time (BR-15, BR-86). */
  async snapshot(refundId: string): Promise<{ chainId: string; branchId: string; slip: RefundPdfSnapshot }> {
    const refund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      include: {
        items: { orderBy: { id: 'asc' }, include: { orderItem: { include: { children: { orderBy: { createdAt: 'asc' } } } } } },
        payment: { select: { method: true, provider: true, amount: true, receivedAmount: true } },
        order: {
          include: {
            branch: { include: { chain: { include: { branding: true } } } },
            refunds: { select: { id: true, amount: true, paymentId: true, requestedAt: true } },
          },
        },
      },
    });
    if (!refund) throw new NotFoundException('Refund not found');
    const order = refund.order;
    const actorEmployeeId = refund.completedByEmployeeId ?? refund.requestedByEmployeeId;
    const [actor, approval] = await Promise.all([
      actorEmployeeId ? this.prisma.employee.findUnique({ where: { id: actorEmployeeId }, select: { firstName: true, lastName: true } }) : null,
      this.prisma.refundApprovalRequest.findFirst({ where: { refundId }, select: { reviewedByEmployeeId: true } }),
    ]);
    const approver = approval?.reviewedByEmployeeId
      ? await this.prisma.employee.findUnique({ where: { id: approval.reviewedByEmployeeId }, select: { firstName: true, lastName: true } })
      : null;
    const collected = refund.payment.receivedAmount ?? refund.payment.amount;
    // Cumulative up to and including this refund, so reprinting an old slip shows the same totals.
    const refunded = order.refunds
      .filter((item) => item.paymentId === refund.paymentId && (item.requestedAt < refund.requestedAt || (item.requestedAt.getTime() === refund.requestedAt.getTime() && item.id <= refund.id)))
      .reduce((sum, item) => sum.add(item.amount), new Prisma.Decimal(0));
    const branding = order.branch.chain.branding;
    const name = (person: { firstName: string; lastName: string } | null) => (person ? `${person.firstName} ${person.lastName}`.trim() : '—');
    const slip: RefundPdfSnapshot = {
      refundId: refund.id,
      orderCode: order.orderCode,
      callNumber: order.callNumber,
      paidAt: order.paidAt,
      currency: order.branch.chain.currency,
      seller: {
        name: branding?.displayName ?? order.branch.chain.name,
        branchName: order.branch.name,
        address: [order.branch.addressLine1, order.branch.addressLine2, order.branch.ward, order.branch.district, order.branch.city].filter(Boolean).join(', '),
        phone: order.branch.phone,
      },
      paidWith: refund.payment.provider === PaymentProvider.PAYOS || refund.payment.method !== PaymentMethod.CASH ? 'QR' : 'CASH',
      scope: refunded.gte(collected) ? 'FULL' : 'PARTIAL',
      lines: refund.items.map((item) => ({
        itemName: item.orderItem.itemName,
        quantity: item.quantity,
        unitPrice: item.orderItem.unitPrice,
        refundAmount: item.refundAmount,
        lineType: item.orderItem.lineType,
        selectedOptions: item.orderItem.selectedOptions,
        children: item.orderItem.children.map((child) => ({ itemName: child.itemName, quantity: child.quantity })),
      })),
      refundAmount: refund.amount,
      totalCollected: collected,
      totalRefunded: refunded,
      reason: refund.reason,
      refundedBy: name(actor),
      refundedByRole: refund.completedByRole ?? refund.requestedByRole,
      refundedAt: refund.completedAt ?? refund.requestedAt,
      approvedBy: approver ? name(approver) : null,
    };
    return { chainId: order.branch.chainId, branchId: order.branchId, slip };
  }

  private safe(value: string) {
    return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  }
}
