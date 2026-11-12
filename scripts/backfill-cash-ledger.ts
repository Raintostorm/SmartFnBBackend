import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  CashLedgerDirection,
  CashLedgerSourceType,
  PaymentProvider,
  PaymentStatus,
  RefundStatus,
  PrismaClient,
} from '../src/generated/prisma/client.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const payments = await prisma.payment.findMany({
  where: { status: PaymentStatus.SUCCESS, orderId: { not: null }, paidAt: { not: null } },
  include: {
    order: { select: { id: true, branchId: true, branch: { select: { chainId: true } } } },
  },
});
await prisma.cashLedgerEntry.createMany({
  skipDuplicates: true,
  data: payments
    .filter((p) => p.order)
    .map((payment) => ({
      chainId: payment.order!.branch.chainId,
      branchId: payment.order!.branchId,
      orderId: payment.order!.id,
      paymentId: payment.id,
      direction: CashLedgerDirection.INFLOW,
      sourceType:
        payment.provider === PaymentProvider.CASH
          ? CashLedgerSourceType.CASH_PAYMENT
          : CashLedgerSourceType.PAYOS_RECHECK,
      sourceId: payment.id,
      paymentMethod: payment.method,
      amount: payment.amount,
      occurredAt: payment.paidAt!,
    })),
});

const refunds = await prisma.refund.findMany({
  where: { status: RefundStatus.COMPLETED, completedAt: { not: null } },
  include: {
    order: { select: { branchId: true, branch: { select: { chainId: true } } } },
    payment: { select: { method: true } },
  },
});
await prisma.cashLedgerEntry.createMany({
  skipDuplicates: true,
  data: refunds.map((refund) => ({
    chainId: refund.order.branch.chainId,
    branchId: refund.order.branchId,
    orderId: refund.orderId,
    paymentId: refund.paymentId,
    refundId: refund.id,
    direction: CashLedgerDirection.OUTFLOW,
    sourceType: CashLedgerSourceType.REFUND,
    sourceId: refund.id,
    paymentMethod: refund.payment.method,
    amount: refund.amount,
    occurredAt: refund.completedAt!,
  })),
});

console.log(
  `Cash ledger backfill complete: ${payments.length} payment(s), ${refunds.length} refund(s) scanned.`,
);
await prisma.$disconnect();
