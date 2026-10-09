import {
  BadRequestException,
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  OrderItemStatus,
  OrderPaymentStatus,
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
  PayosChannelStatus,
  PrintDocumentType,
  Prisma,
  WebhookProcessingStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { RealtimePublisher } from '../../realtime/realtime.publisher.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import type { CreatePayosPaymentDto } from './dto/payos-payment.dto.js';
import { PayosApiError, PayosApiService } from './payos-api.service.js';
import { PayosCipherService } from './payos-cipher.service.js';
import { verifyPayosSignature } from './payos-signature.js';
import { PayosVerificationStore } from './payos-verification.store.js';
import { OrderTrackingService } from '../order-tracking/order-tracking.service.js';

interface PayosWebhook {
  code?: string;
  success?: boolean;
  signature?: string;
  data?: Record<string, unknown> & {
    orderCode?: number;
    amount?: number;
    reference?: string;
    paymentLinkId?: string;
  };
}

@Injectable()
export class PayosPaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branchAccess: BranchAccessService,
    private readonly cipher: PayosCipherService,
    private readonly api: PayosApiService,
    private readonly realtime: RealtimePublisher,
    private readonly verification: PayosVerificationStore,
    private readonly tracking: OrderTrackingService,
  ) {}

  async create(user: AuthenticatedUser, orderId: string, dto: CreatePayosPaymentDto) {
    if (!user.employeeId || !user.branchId)
      throw new ForbiddenException('An assigned employee profile is required');
    await this.branchAccess.assertSubscriptionAllowsWrite(user.branchId);
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId: user.branchId, type: OrderType.COUNTER_PICKUP },
      include: { branch: { select: { chainId: true } }, payments: true },
    });
    if (!order) throw new NotFoundException('Counter order was not found in your branch');
    if (order.status !== OrderStatus.CONFIRMED || order.paymentStatus !== OrderPaymentStatus.UNPAID)
      throw new ConflictException('Order is not awaiting payment');
    const station = await this.prisma.posStation.findFirst({
      where: { id: dto.stationId, branchId: user.branchId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!station) throw new NotFoundException('Active POS station was not found in your branch');
    const pending = order.payments.find(
      (item) =>
        item.provider === PaymentProvider.PAYOS &&
        item.status === PaymentStatus.PENDING &&
        (!item.expiresAt || item.expiresAt > new Date()),
    );
    if (pending?.checkoutUrl) {
      if (pending.stationId !== station.id) {
        return this.prisma.payment.update({
          where: { id: pending.id },
          data: { stationId: station.id },
        });
      }
      return pending;
    }
    await this.prisma.payment.updateMany({
      where: {
        orderId,
        provider: PaymentProvider.PAYOS,
        status: PaymentStatus.PENDING,
        expiresAt: { lte: new Date() },
      },
      data: { status: PaymentStatus.FAILED, failureReason: 'PAYOS_EXPIRED' },
    });

    const channel = await this.prisma.payosChannel.findUnique({
      where: { chainId: order.branch.chainId },
    });
    if (!channel) throw new ConflictException('PayOS has not been configured for this chain');
    if (!new Prisma.Decimal(order.totalAmount).isInteger())
      throw new BadRequestException('PayOS payment amount must be a whole VND value');

    const providerOrderCode = Number(`${Date.now()}${Math.floor(Math.random() * 90 + 10)}`);
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    const credentials = {
      clientId: this.cipher.decrypt(channel.clientIdCipher),
      apiKey: this.cipher.decrypt(channel.apiKeyCipher),
      checksumKey: this.cipher.decrypt(channel.checksumKeyCipher),
    };
    let result;
    try {
      result = await this.api.createPayment(credentials, {
        orderCode: providerOrderCode,
        amount: new Prisma.Decimal(order.totalAmount).toNumber(),
        description: `DH ${order.orderCode}`.slice(0, 25),
        cancelUrl: dto.cancelUrl,
        returnUrl: dto.returnUrl,
        expiredAt: Math.floor(expiresAt.getTime() / 1000),
      });
      await this.prisma.payosChannel.update({
        where: { id: channel.id },
        data: { status: PayosChannelStatus.LINKED, lastError: null, lastVerifiedAt: new Date() },
      });
    } catch (error) {
      if (error instanceof PayosApiError && !error.temporary) {
        await this.prisma.payosChannel.update({
          where: { id: channel.id },
          data: { status: PayosChannelStatus.ERROR, lastError: error.message.slice(0, 1000) },
        });
      }
      if (error instanceof PayosApiError) {
        if (error.temporary) throw new BadGatewayException(error.message);
        throw new BadRequestException(error.message);
      }
      throw error;
    }
    return this.prisma.payment.create({
      data: {
        paymentCode: `PAY-${Date.now()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
        orderId,
        processedById: user.employeeId,
        stationId: station.id,
        method: PaymentMethod.BANK_TRANSFER,
        provider: PaymentProvider.PAYOS,
        status: PaymentStatus.PENDING,
        amount: order.totalAmount,
        providerOrderCode: String(providerOrderCode),
        transactionRef: result.paymentLinkId,
        checkoutUrl: result.checkoutUrl,
        qrCode: result.qrCode,
        expiresAt,
      },
    });
  }

  async webhook(webhookCode: string, payload: PayosWebhook) {
    const data = payload.data;
    const signature = payload.signature;
    if (!data?.orderCode || !signature) throw new UnauthorizedException('Invalid PayOS webhook');
    const pendingVerification = this.verification.get(webhookCode);
    if (pendingVerification) {
      if (!verifyPayosSignature(data, signature, pendingVerification.checksumKey))
        throw new UnauthorizedException('Invalid PayOS signature');
      return { success: true };
    }

    const channel = await this.prisma.payosChannel.findUnique({ where: { webhookCode } });
    if (!channel) throw new NotFoundException('PayOS channel was not found');
    if (!verifyPayosSignature(data, signature, this.cipher.decrypt(channel.checksumKeyCipher)))
      throw new UnauthorizedException('Invalid PayOS signature');

    const payment = await this.prisma.payment.findUnique({
      where: { providerOrderCode: String(data.orderCode) },
      include: { order: { include: { branch: { select: { chainId: true } } } } },
    });
    // PayOS sends a signed sample while confirming a webhook. Accept it without mutating an order.
    if (!payment?.order) return { success: true };
    if (payment.order.branch.chainId !== channel.chainId)
      throw new UnauthorizedException('PayOS channel does not match the payment chain');

    const idempotencyKey = `${data.orderCode}:${data.reference || data.paymentLinkId || signature}`;
    const result = await this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.paymentWebhookEvent.findUnique({
          where: { provider_idempotencyKey: { provider: PaymentProvider.PAYOS, idempotencyKey } },
        });
        if (existing) return { duplicate: true, paid: payment.status === PaymentStatus.SUCCESS };
        const event = await tx.paymentWebhookEvent.create({
          data: {
            paymentId: payment.id,
            provider: PaymentProvider.PAYOS,
            idempotencyKey,
            providerOrderCode: String(data.orderCode),
            signatureValid: true,
            payload: payload as Prisma.InputJsonValue,
          },
        });
        if (payload.code !== '00' || payload.success !== true) {
          await tx.paymentWebhookEvent.update({
            where: { id: event.id },
            data: { status: WebhookProcessingStatus.REJECTED, processedAt: new Date() },
          });
          return { duplicate: false, paid: false };
        }
        if (!new Prisma.Decimal(data.amount ?? -1).equals(payment.amount)) {
          await tx.payment.update({
            where: { id: payment.id },
            data: {
              status: PaymentStatus.FAILED,
              failureReason: `PAYOS_AMOUNT_MISMATCH: expected ${payment.amount.toString()}, received ${data.amount ?? 'unknown'}`,
            },
          });
          await tx.paymentWebhookEvent.update({
            where: { id: event.id },
            data: {
              status: WebhookProcessingStatus.REJECTED,
              errorMessage: 'PayOS amount does not match the order',
              processedAt: new Date(),
            },
          });
          return { duplicate: false, paid: false };
        }

        const current = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
        if (current.status === PaymentStatus.SUCCESS) {
          await tx.paymentWebhookEvent.update({
            where: { id: event.id },
            data: { status: WebhookProcessingStatus.PROCESSED, processedAt: new Date() },
          });
          return { duplicate: true, paid: true };
        }
        const order = await tx.order.findUniqueOrThrow({
          where: { id: payment.orderId! },
          include: { items: true, branch: { select: { timezone: true } } },
        });
        if (
          order.paymentStatus !== OrderPaymentStatus.UNPAID ||
          order.status !== OrderStatus.CONFIRMED
        )
          throw new ConflictException('Order is no longer awaiting payment');
        const now = new Date();
        const businessDate = this.businessDate(order.branch.timezone);
        const sequence = await tx.branchDailySequence.upsert({
          where: { branchId_businessDate: { branchId: order.branchId, businessDate } },
          create: { branchId: order.branchId, businessDate, nextNumber: 1 },
          update: { nextNumber: { increment: 1 } },
        });
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.SUCCESS,
            providerTransactionId: data.reference,
            confirmedAt: now,
            paidAt: now,
          },
        });
        for (const item of order.items) {
          await tx.orderItem.update({
            where: { id: item.id },
            data: {
              status: OrderItemStatus.QUEUED,
              queuedAt: now,
              units: {
                create: Array.from({ length: item.quantity }, (_, index) => ({
                  sequence: index + 1,
                  status: OrderItemStatus.QUEUED,
                })),
              },
            },
          });
        }
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: OrderStatus.SUBMITTED,
            paymentStatus: OrderPaymentStatus.PAID,
            paidAt: now,
            submittedAt: now,
            businessDate,
            callNumber: sequence.nextNumber,
          },
        });
        const tracking = await this.tracking.ensureForOrder(tx, order.id);
        if (payment.processedById) {
          await tx.printJob.createMany({
            data: [PrintDocumentType.RECEIPT, PrintDocumentType.QUEUE_TICKET].map((type) => ({
              orderId: order.id,
              branchId: order.branchId,
              stationId: payment.stationId,
              type,
              printedById: payment.processedById!,
            })),
          });
        }
        await tx.paymentWebhookEvent.update({
          where: { id: event.id },
          data: { status: WebhookProcessingStatus.PROCESSED, processedAt: now },
        });
        return {
          duplicate: false,
          paid: true,
          branchId: order.branchId,
          callNumber: sequence.nextNumber,
          tracking,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    if ('branchId' in result && result.branchId) {
      this.realtime.branch(result.branchId, 'payment.confirmed', {
        orderId: payment.orderId,
        callNumber: result.callNumber,
      });
      this.realtime.branch(result.branchId, 'preparation.order.queued', {
        orderId: payment.orderId,
        callNumber: result.callNumber,
      });
      this.realtime.callingDisplay(result.branchId, 'calling.order.queued', {
        orderId: payment.orderId,
        callNumber: result.callNumber,
        status: OrderStatus.SUBMITTED,
      });
    }
    return { success: true };
  }

  async recheck(user: AuthenticatedUser, paymentId: string) {
    const { payment, credentials } = await this.scopedPayment(user, paymentId);
    if (payment.status === PaymentStatus.SUCCESS) return payment;
    if (payment.status !== PaymentStatus.PENDING)
      throw new ConflictException('Only a pending PayOS payment can be rechecked');
    let state;
    try {
      state = await this.api.getPayment(
        credentials,
        payment.transactionRef ?? payment.providerOrderCode!,
      );
    } catch (error) {
      this.rethrowPayos(error);
    }
    const providerStatus = String(state!.status ?? '').toUpperCase();
    if (providerStatus === 'PAID') {
      const amount = state!.amountPaid ?? state!.amount;
      const reference = state!.transactions?.at(-1)?.reference ?? state!.id;
      return this.settleFromProvider(payment.id, amount, reference);
    }
    if (['CANCELLED', 'EXPIRED'].includes(providerStatus) || this.isExpired(payment.expiresAt)) {
      return this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.FAILED,
          failureReason: providerStatus === 'CANCELLED' ? 'PAYOS_CANCELLED' : 'PAYOS_EXPIRED',
        },
      });
    }
    return payment;
  }

  async cancel(user: AuthenticatedUser, paymentId: string, reason: string) {
    const { payment, credentials } = await this.scopedPayment(user, paymentId);
    if (payment.status !== PaymentStatus.PENDING)
      throw new ConflictException('Only a pending PayOS payment can be cancelled');
    try {
      await this.api.cancelPayment(
        credentials,
        payment.transactionRef ?? payment.providerOrderCode!,
        reason.trim(),
      );
    } catch (error) {
      this.rethrowPayos(error);
    }
    return this.prisma.payment.update({
      where: { id: payment.id },
      data: { status: PaymentStatus.FAILED, failureReason: `PAYOS_CANCELLED: ${reason.trim()}` },
    });
  }

  private async scopedPayment(user: AuthenticatedUser, paymentId: string) {
    if (!user.employeeId || !user.branchId)
      throw new ForbiddenException('An assigned employee profile is required');
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        provider: PaymentProvider.PAYOS,
        order: { branchId: user.branchId, type: OrderType.COUNTER_PICKUP },
      },
      include: { order: { include: { branch: { select: { chainId: true } } } } },
    });
    if (!payment?.order) throw new NotFoundException('PayOS payment was not found in your branch');
    const channel = await this.prisma.payosChannel.findUnique({
      where: { chainId: payment.order.branch.chainId },
    });
    if (!channel) throw new ConflictException('PayOS has not been configured for this chain');
    return {
      payment,
      credentials: {
        clientId: this.cipher.decrypt(channel.clientIdCipher),
        apiKey: this.cipher.decrypt(channel.apiKeyCipher),
        checksumKey: this.cipher.decrypt(channel.checksumKeyCipher),
      },
    };
  }

  private async settleFromProvider(paymentId: string, amount?: number, reference?: string) {
    const result = await this.prisma.$transaction(
      async (tx) => {
        const payment = await tx.payment.findUniqueOrThrow({
          where: { id: paymentId },
          include: { order: { include: { items: true, branch: { select: { timezone: true } } } } },
        });
        if (payment.status === PaymentStatus.SUCCESS) return { payment, changed: false };
        if (payment.status !== PaymentStatus.PENDING || !payment.order)
          throw new ConflictException('Payment is no longer pending');
        if (amount == null || !new Prisma.Decimal(amount).equals(payment.amount)) {
          const failed = await tx.payment.update({
            where: { id: payment.id },
            data: {
              status: PaymentStatus.FAILED,
              failureReason: `PAYOS_AMOUNT_MISMATCH: expected ${payment.amount.toString()}, received ${amount ?? 'unknown'}`,
            },
          });
          return { payment: failed, changed: false };
        }
        const order = payment.order;
        if (
          order.paymentStatus !== OrderPaymentStatus.UNPAID ||
          order.status !== OrderStatus.CONFIRMED
        )
          throw new ConflictException('Order is no longer awaiting payment');
        const now = new Date();
        const businessDate = this.businessDate(order.branch.timezone);
        const sequence = await tx.branchDailySequence.upsert({
          where: { branchId_businessDate: { branchId: order.branchId, businessDate } },
          create: { branchId: order.branchId, businessDate, nextNumber: 1 },
          update: { nextNumber: { increment: 1 } },
        });
        const updated = await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.SUCCESS,
            providerTransactionId: reference,
            confirmedAt: now,
            paidAt: now,
          },
        });
        for (const item of order.items) {
          await tx.orderItem.update({
            where: { id: item.id },
            data: {
              status: OrderItemStatus.QUEUED,
              queuedAt: now,
              units: {
                create: Array.from({ length: item.quantity }, (_, index) => ({
                  sequence: index + 1,
                  status: OrderItemStatus.QUEUED,
                })),
              },
            },
          });
        }
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: OrderStatus.SUBMITTED,
            paymentStatus: OrderPaymentStatus.PAID,
            paidAt: now,
            submittedAt: now,
            businessDate,
            callNumber: sequence.nextNumber,
          },
        });
        const tracking = await this.tracking.ensureForOrder(tx, order.id);
        if (payment.processedById) {
          await tx.printJob.createMany({
            data: [PrintDocumentType.RECEIPT, PrintDocumentType.QUEUE_TICKET].map((type) => ({
              orderId: order.id,
              branchId: order.branchId,
              stationId: payment.stationId,
              type,
              printedById: payment.processedById!,
            })),
          });
        }
        return {
          payment: updated,
          changed: true,
          branchId: order.branchId,
          orderId: order.id,
          callNumber: sequence.nextNumber,
          tracking,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    if (result.changed && result.branchId) {
      this.realtime.branch(result.branchId, 'payment.confirmed', {
        orderId: result.orderId,
        callNumber: result.callNumber,
      });
      this.realtime.branch(result.branchId, 'preparation.order.queued', {
        orderId: result.orderId,
        callNumber: result.callNumber,
      });
      this.realtime.callingDisplay(result.branchId, 'calling.order.queued', {
        orderId: result.orderId,
        callNumber: result.callNumber,
        status: OrderStatus.SUBMITTED,
      });
    }
    return result.payment;
  }

  private isExpired(expiresAt: Date | null) {
    return expiresAt !== null && expiresAt <= new Date();
  }

  private rethrowPayos(error: unknown): never {
    if (error instanceof PayosApiError) {
      if (error.temporary) throw new BadGatewayException(error.message);
      throw new BadRequestException(error.message);
    }
    throw error;
  }

  private businessDate(timezone: string) {
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    return new Date(`${date}T00:00:00.000Z`);
  }
}
