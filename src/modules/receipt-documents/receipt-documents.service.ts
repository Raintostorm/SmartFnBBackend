import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  OrderPaymentStatus,
  OrderType,
  PaymentStatus,
  ReceiptDocumentStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import { OrderTrackingService } from '../order-tracking/order-tracking.service.js';
import { ReceiptPdfService, type ReceiptPdfSnapshot } from './receipt-pdf.service.js';
import { ReceiptRasterService } from './receipt-raster.service.js';
import { ReceiptStorageService } from './receipt-storage.service.js';

@Injectable()
export class ReceiptDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BranchAccessService,
    private readonly tracking: OrderTrackingService,
    private readonly pdf: ReceiptPdfService,
    private readonly raster: ReceiptRasterService,
    private readonly storage: ReceiptStorageService,
    private readonly config: ConfigService,
  ) {}

  async ensureReady(orderId: string) {
    if (!this.config.get<boolean>('RECEIPT_PDF_ENABLED', true)) return null;
    const snapshot = await this.snapshot(orderId);
    const existing = await this.prisma.receiptDocument.upsert({
      where: { orderId_version: { orderId, version: 1 } },
      create: { orderId, branchId: snapshot.branchId, version: 1 },
      update: {},
    });
    if (existing.status === ReceiptDocumentStatus.READY) return existing;
    try {
      const data = await this.pdf.render(snapshot.receipt);
      const checksum = createHash('sha256').update(data).digest('hex');
      const fileName = `receipt-${this.safe(snapshot.receipt.orderCode)}.pdf`;
      const storageKey = `${snapshot.chainId}/${snapshot.branchId}/${orderId}/v1-${checksum.slice(0, 12)}.pdf`;
      await this.storage.put(storageKey, data);
      return await this.prisma.receiptDocument.update({
        where: { id: existing.id },
        data: {
          status: ReceiptDocumentStatus.READY,
          storageKey,
          fileName,
          mimeType: 'application/pdf',
          fileSize: data.length,
          checksum,
          generatedAt: new Date(),
          errorMessage: null,
        },
      });
    } catch (error) {
      const current = await this.prisma.receiptDocument.findUnique({ where: { id: existing.id } });
      if (current?.status === ReceiptDocumentStatus.READY) return current;
      await this.prisma.receiptDocument.update({
        where: { id: existing.id },
        data: {
          status: ReceiptDocumentStatus.FAILED,
          errorMessage: String(error instanceof Error ? error.message : error).slice(0, 1000),
        },
      });
      return this.prisma.receiptDocument.findUniqueOrThrow({ where: { id: existing.id } });
    }
  }

  async get(user: AuthenticatedUser, orderId: string) {
    const order = await this.scopedOrder(user, orderId);
    if (!this.config.get<boolean>('RECEIPT_PDF_ENABLED', true)) {
      return { status: 'DISABLED', orderId: order.id };
    }
    const document =
      (await this.prisma.receiptDocument.findUnique({
        where: { orderId_version: { orderId, version: 1 } },
      })) ?? (await this.ensureReady(orderId));
    if (!document) return { status: 'DISABLED', orderId };
    const access =
      document.status === ReceiptDocumentStatus.READY && document.storageKey
        ? await this.storage.access(document.storageKey, orderId)
        : { downloadUrl: null, expiresAt: null };
    return {
      id: document.id,
      orderId: order.id,
      status: document.status,
      version: document.version,
      fileName: document.fileName,
      fileSize: document.fileSize,
      checksum: document.checksum,
      generatedAt: document.generatedAt,
      errorMessage: document.errorMessage,
      ...access,
    };
  }

  async retry(user: AuthenticatedUser, orderId: string) {
    await this.scopedOrder(user, orderId);
    const document = await this.prisma.receiptDocument.findUnique({
      where: { orderId_version: { orderId, version: 1 } },
    });
    if (document?.status === ReceiptDocumentStatus.READY) return this.get(user, orderId);
    if (document) {
      await this.prisma.receiptDocument.update({
        where: { id: document.id },
        data: { status: ReceiptDocumentStatus.PENDING, errorMessage: null },
      });
    }
    await this.ensureReady(orderId);
    return this.get(user, orderId);
  }

  async download(user: AuthenticatedUser, orderId: string) {
    await this.scopedOrder(user, orderId);
    const document = await this.prisma.receiptDocument.findUnique({
      where: { orderId_version: { orderId, version: 1 } },
    });
    if (!document || document.status !== ReceiptDocumentStatus.READY || !document.storageKey) {
      throw new NotFoundException('Receipt PDF is not ready');
    }
    return {
      data: await this.storage.read(document.storageKey),
      fileName: document.fileName ?? `receipt-${orderId}.pdf`,
    };
  }

  /**
   * Ảnh PNG của chính file PDF đã lưu, rộng 768px và đã cắt phần trống cuối phiếu, để Mobile in lên máy nhiệt
   * đúng nội dung bản lưu. Chưa có PDF thì sinh luôn (idempotent như `get`); không có/không sinh được → 404 để
   * Mobile quay về in bằng bill dựng cục bộ.
   */
  async printImage(user: AuthenticatedUser, orderId: string) {
    await this.scopedOrder(user, orderId);
    let document = await this.prisma.receiptDocument.findUnique({
      where: { orderId_version: { orderId, version: 1 } },
    });
    if (document?.status !== ReceiptDocumentStatus.READY) {
      document = await this.ensureReady(orderId);
    }
    if (!document || document.status !== ReceiptDocumentStatus.READY || !document.storageKey) {
      throw new NotFoundException('Receipt PDF is not ready');
    }
    return { data: await this.raster.render(await this.storage.read(document.storageKey)) };
  }

  private async scopedOrder(user: AuthenticatedUser, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, branchId: true, type: true, paymentStatus: true },
    });
    if (!order || order.type !== OrderType.COUNTER_PICKUP) {
      throw new NotFoundException('Paid counter order was not found');
    }
    await this.access.assertCanAccessBranch(user, order.branchId);
    if (order.paymentStatus !== OrderPaymentStatus.PAID) {
      throw new ConflictException('Receipt PDF is available only after payment');
    }
    if (!user.employeeId && !user.ownerId) {
      throw new ForbiddenException('An assigned restaurant account is required');
    }
    return order;
  }

  private async snapshot(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: { orderBy: { createdAt: 'asc' } },
        payments: {
          where: { status: PaymentStatus.SUCCESS },
          orderBy: { paidAt: 'desc' },
          take: 1,
        },
        branch: { include: { chain: { include: { branding: true } } } },
        createdByCashier: { select: { firstName: true, lastName: true } },
      },
    });
    if (
      !order ||
      order.type !== OrderType.COUNTER_PICKUP ||
      order.paymentStatus !== OrderPaymentStatus.PAID ||
      !order.paidAt
    ) {
      throw new ConflictException('Receipt PDF requires a paid counter order');
    }
    const branding = order.branch.chain.branding;
    const tracking = await this.tracking.presentationForOrder(order.id);
    const receipt: ReceiptPdfSnapshot = {
      orderCode: order.orderCode,
      callNumber: order.callNumber,
      paidAt: order.paidAt,
      currency: order.branch.chain.currency,
      seller: {
        name: branding?.displayName ?? order.branch.chain.name,
        branchName: order.branch.name,
        address: [
          order.branch.addressLine1,
          order.branch.addressLine2,
          order.branch.ward,
          order.branch.district,
          order.branch.city,
        ]
          .filter(Boolean)
          .join(', '),
        phone: order.branch.phone,
      },
      cashier: order.createdByCashier
        ? `${order.createdByCashier.firstName} ${order.createdByCashier.lastName}`.trim()
        : null,
      items: order.items,
      totalAmount: order.totalAmount,
      payment: order.payments[0] ?? null,
      trackingUrl: tracking?.url ?? null,
    };
    return { branchId: order.branchId, chainId: order.branch.chainId, receipt };
  }

  private safe(value: string) {
    return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  }
}
