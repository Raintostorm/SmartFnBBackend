import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InvoiceStatus,
  OrderItemStatus,
  PaymentStatus,
  Prisma,
  TableSessionStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import type { CancelInvoiceDto, InvoiceListQueryDto, IssueInvoiceDto } from './dto/invoice.dto.js';

const invoiceInclude = {
  items: { orderBy: { createdAt: 'asc' as const } },
  payments: { include: { payment: true } },
  tableSession: {
    select: {
      sessionCode: true,
      guestCount: true,
      openedAt: true,
      paidAt: true,
      tables: {
        where: { releasedAt: null },
        select: { table: { select: { code: true, name: true } } },
      },
    },
  },
  issuedBy: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
} satisfies Prisma.InvoiceInclude;

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branchAccess: BranchAccessService,
    private readonly config: ConfigService,
  ) {}

  async preview(tableSessionId: string, user: AuthenticatedUser) {
    const session = await this.sessionSnapshot(tableSessionId);
    await this.branchAccess.assertCanAccessBranch(user, session.branchId);
    return this.calculateBill(session);
  }

  async issue(tableSessionId: string, dto: IssueInvoiceDto, user: AuthenticatedUser) {
    const actor = this.employee(user);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.invoice.findFirst({
        where: { tableSessionId, status: InvoiceStatus.ISSUED },
        include: invoiceInclude,
      });
      if (existing) return existing;

      const session = await this.sessionSnapshot(tableSessionId, tx);
      if (session.branchId !== actor.branchId) {
        throw new ForbiddenException('Table session does not belong to your assigned branch');
      }
      if (session.status !== TableSessionStatus.PAID || !session.paidAt) {
        throw new ConflictException(
          'Invoice can only be issued after the table session is fully paid',
        );
      }
      const bill = this.calculateBill(session);
      if (bill.totalPaid.lessThan(bill.totalAmount)) {
        throw new ConflictException('Successful payments do not cover the table-session total');
      }

      const prefix = this.config.get<string>('INVOICE_NUMBER_PREFIX', 'INV');
      const invoiceSuffix = `${Date.now()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
      const maxBranchCodeLength = Math.max(1, 50 - prefix.length - invoiceSuffix.length - 2);
      const invoiceNumber = `${prefix}-${session.branch.code.slice(0, maxBranchCodeLength)}-${invoiceSuffix}`;
      const address = [
        session.branch.addressLine1,
        session.branch.addressLine2,
        session.branch.ward,
        session.branch.district,
        session.branch.city,
      ]
        .filter(Boolean)
        .join(', ');
      return tx.invoice.create({
        data: {
          invoiceNumber,
          chainId: session.branch.chainId,
          branchId: session.branchId,
          tableSessionId,
          currency: session.branch.chain.currency,
          subtotal: bill.subtotal,
          discountAmount: bill.discountAmount,
          taxAmount: bill.taxAmount,
          serviceCharge: bill.serviceCharge,
          totalAmount: bill.totalAmount,
          paidAmount: bill.totalPaid,
          sellerName: session.branch.chain.branding?.displayName ?? session.branch.chain.name,
          sellerTaxCode: session.branch.chain.taxCode,
          sellerAddress: address,
          sellerPhone: session.branch.phone,
          sellerLogoUrl: session.branch.chain.branding?.logoUrl ?? session.branch.chain.logoUrl,
          customerName: dto.customerName ?? session.guestName,
          customerPhone: dto.customerPhone ?? session.guestPhone,
          customerEmail: dto.customerEmail,
          customerTaxCode: dto.customerTaxCode,
          customerAddress: dto.customerAddress,
          issuedById: actor.employeeId,
          items: {
            create: bill.items.map((item) => ({
              orderItemId: item.id,
              itemName: item.itemName,
              unitPrice: item.unitPrice,
              quantity: item.quantity,
              discountAmount: item.discountAmount,
              lineTotal: item.totalPrice,
              selectedOptions: item.selectedOptions ?? Prisma.JsonNull,
              specialInstructions: item.specialInstructions,
            })),
          },
          payments: {
            create: session.payments.map((payment) => ({
              paymentId: payment.id,
              allocatedAmount: payment.amount,
            })),
          },
        },
        include: invoiceInclude,
      });
    });
  }

  async get(invoiceId: string, user: AuthenticatedUser) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: invoiceInclude,
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    await this.branchAccess.assertCanAccessBranch(user, invoice.branchId);
    return invoice;
  }

  async list(branchId: string, query: InvoiceListQueryDto, user: AuthenticatedUser) {
    await this.branchAccess.assertCanAccessBranch(user, branchId);
    const issuedAt = {
      ...(query.from ? { gte: new Date(query.from) } : {}),
      ...(query.to ? { lte: new Date(query.to) } : {}),
    };
    const where: Prisma.InvoiceWhereInput = {
      branchId,
      ...(query.from || query.to ? { issuedAt } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.invoice.findMany({
        where,
        include: invoiceInclude,
        orderBy: { issuedAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.invoice.count({ where }),
    ]);
    return { items, total, page: query.page, limit: query.limit };
  }

  async cancel(invoiceId: string, dto: CancelInvoiceDto, user: AuthenticatedUser) {
    const actor = this.employee(user);
    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (invoice.branchId !== actor.branchId) {
      throw new ForbiddenException('Invoice does not belong to your assigned branch');
    }
    if (invoice.status !== InvoiceStatus.ISSUED) {
      throw new ConflictException('Only an issued invoice can be cancelled');
    }
    return this.prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        status: InvoiceStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelledById: actor.employeeId,
        cancellationReason: dto.reason,
      },
      include: invoiceInclude,
    });
  }

  private employee(user: AuthenticatedUser) {
    if (!user.employeeId || !user.branchId) {
      throw new ForbiddenException('An assigned employee profile is required');
    }
    return { employeeId: user.employeeId, branchId: user.branchId };
  }

  private sessionSnapshot(
    tableSessionId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    return client.tableSession
      .findUnique({
        where: { id: tableSessionId },
        include: {
          branch: {
            include: { chain: { include: { branding: true } } },
          },
          orders: {
            where: { status: { not: 'CANCELLED' } },
            include: { items: { where: { status: { not: OrderItemStatus.CANCELLED } } } },
          },
          payments: { where: { status: PaymentStatus.SUCCESS } },
        },
      })
      .then((session) => {
        if (!session) throw new NotFoundException('Table session not found');
        return session;
      });
  }

  private calculateBill(session: Awaited<ReturnType<InvoicesService['sessionSnapshot']>>) {
    const zero = new Prisma.Decimal(0);
    const items = session.orders.flatMap((order) => order.items);
    return {
      tableSessionId: session.id,
      sessionCode: session.sessionCode,
      branchId: session.branchId,
      items,
      subtotal: session.orders.reduce((sum, order) => sum.add(order.subtotal), zero),
      discountAmount: session.orders.reduce((sum, order) => sum.add(order.discountAmount), zero),
      taxAmount: session.orders.reduce((sum, order) => sum.add(order.taxAmount), zero),
      serviceCharge: session.orders.reduce((sum, order) => sum.add(order.serviceCharge), zero),
      totalAmount: session.orders.reduce((sum, order) => sum.add(order.totalAmount), zero),
      totalPaid: session.payments.reduce((sum, payment) => sum.add(payment.amount), zero),
    };
  }
}
