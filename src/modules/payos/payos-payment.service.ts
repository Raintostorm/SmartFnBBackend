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
  OrderPaymentStatus,
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
  PayosChannelStatus,
  Prisma,
  WebhookProcessingStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import type { CreatePayosPaymentDto } from './dto/payos-payment.dto.js';
import { PayosApiError, PayosApiService } from './payos-api.service.js';
import { PayosCipherService } from './payos-cipher.service.js';
import { verifyPayosSignature } from './payos-signature.js';
import { PayosVerificationStore } from './payos-verification.store.js';
import { CounterPaymentSettlementService } from '../payments/counter-payment-settlement.service.js';

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
    private readonly verification: PayosVerificationStore,
    private readonly settlement: CounterPaymentSettlementService,
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
    const eventResult = await this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.paymentWebhookEvent.findUnique({
          where: { provider_idempotencyKey: { provider: PaymentProvider.PAYOS, idempotencyKey } },
        });
        if (existing) {
          if (
            existing.status === WebhookProcessingStatus.PROCESSED ||
            existing.status === WebhookProcessingStatus.REJECTED
          )
            return { duplicate: true };
          return {
            duplicate: false,
            accepted: true,
            eventId: existing.id,
            mismatch: !new Prisma.Decimal(data.amount ?? -1).equals(payment.amount),
          };
        }
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
          return { duplicate: false, accepted: false, eventId: event.id, mismatch: false };
        }
        return {
          duplicate: false,
          accepted: true,
          eventId: event.id,
          mismatch: !new Prisma.Decimal(data.amount ?? -1).equals(payment.amount),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    if (eventResult.duplicate || !eventResult.accepted) return { success: true };
    try {
      if (eventResult.mismatch) {
        await this.settlement.markAmountMismatch(payment.id, data.amount ?? -1, data.reference);
      } else {
        await this.settlement.settle({
          paymentId: payment.id,
          source: 'PAYOS_WEBHOOK',
          receivedAmount: data.amount!,
          providerTransactionId: data.reference,
        });
      }
      await this.prisma.paymentWebhookEvent.update({
        where: { id: eventResult.eventId },
        data: { status: WebhookProcessingStatus.PROCESSED, processedAt: new Date() },
      });
    } catch (error) {
      if (error instanceof ConflictException && error.message === 'PAYMENT_ALREADY_SETTLED') {
        await this.prisma.paymentWebhookEvent.update({
          where: { id: eventResult.eventId },
          data: { status: WebhookProcessingStatus.PROCESSED, processedAt: new Date() },
        });
        return { success: true };
      }
      await this.prisma.paymentWebhookEvent.update({
        where: { id: eventResult.eventId },
        data: {
          status: WebhookProcessingStatus.FAILED,
          errorMessage: String(error instanceof Error ? error.message : error).slice(0, 1000),
        },
      });
      throw error;
    }
    return { success: true };
  }

  async recheck(user: AuthenticatedUser, paymentId: string) {
    const { payment, credentials } = await this.scopedPayment(user, paymentId);
    if (payment.status === PaymentStatus.SUCCESS) return payment;
    if (
      payment.status !== PaymentStatus.PENDING &&
      payment.status !== PaymentStatus.AMOUNT_MISMATCH
    )
      throw new ConflictException('Only a pending or mismatched PayOS payment can be rechecked');
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
      const transaction = state!.transactions?.at(-1);
      const amount = state!.amountPaid ?? state!.amount ?? transaction?.amount;
      if (amount == null) throw new BadGatewayException('PayOS did not return the paid amount');
      const reference = transaction?.reference ?? state!.id;
      try {
        if (!new Prisma.Decimal(amount).equals(payment.amount)) {
          return this.settlement.markAmountMismatch(payment.id, amount, reference);
        }
        const result = await this.settlement.settle({
          paymentId: payment.id,
          source: 'PAYOS_RECHECK',
          receivedAmount: amount,
          providerTransactionId: reference,
        });
        return { ...result.payment, order: result.order, tracking: result.tracking };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
          throw new ConflictException('Payment changed concurrently; reload before retrying');
        }
        throw error;
      }
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
}
