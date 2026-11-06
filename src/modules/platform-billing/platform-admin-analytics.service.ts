import { BadRequestException, Injectable } from '@nestjs/common';
import {
  BusinessSubscriptionStatus,
  Prisma,
  RegistrationApplicationStatus,
  SubscriptionCheckoutStatus,
  SubscriptionEventType,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type {
  ListPlatformInvoicesQueryDto,
  PlatformRevenueQueryDto,
} from '../platform-admin/dto/platform-admin.dto.js';

type RevenueInvoice = {
  source: 'REGISTRATION' | 'SUBSCRIPTION';
  id: string;
  businessId: string | null;
  businessName: string;
  planId: string;
  planName: string;
  amount: number;
  paidAt: Date;
};

@Injectable()
export class PlatformAdminAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview() {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [
      registrationGroups,
      subscriptions,
      plans,
      recurringRevenue,
      activationRevenue,
      reviewRecurring,
      reviewActivation,
    ] = await Promise.all([
      this.prisma.registrationApplication.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.businessSubscription.findMany({
        select: {
          status: true,
          expiresAt: true,
          monthlyPrice: true,
          plan: { select: { code: true } },
        },
      }),
      this.prisma.servicePlan.count({ where: { isActive: true, code: { not: 'TRIAL' } } }),
      this.prisma.subscriptionCheckout.aggregate({
        where: { status: SubscriptionCheckoutStatus.PAID, paidAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
      this.prisma.registrationCheckout.aggregate({
        where: { status: SubscriptionCheckoutStatus.PAID, paidAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
      this.prisma.subscriptionCheckout.count({
        where: { status: SubscriptionCheckoutStatus.NEEDS_REVIEW },
      }),
      this.prisma.registrationCheckout.count({
        where: { status: SubscriptionCheckoutStatus.NEEDS_REVIEW },
      }),
    ]);

    const registrationCounts = Object.fromEntries(
      Object.values(RegistrationApplicationStatus).map((status) => [status, 0]),
    ) as Record<RegistrationApplicationStatus, number>;
    for (const row of registrationGroups) registrationCounts[row.status] = row._count._all;

    const states = this.subscriptionStates(subscriptions, now);
    const mrr = subscriptions
      .filter(
        (subscription) =>
          subscription.status === BusinessSubscriptionStatus.ACTIVE &&
          subscription.expiresAt > now &&
          subscription.plan.code !== 'TRIAL',
      )
      .reduce((sum, subscription) => sum + Number(subscription.monthlyPrice), 0);

    return {
      registrations: registrationCounts,
      businesses: states,
      activePlans: plans,
      mrr,
      revenueThisMonth:
        Number(recurringRevenue._sum.amount ?? 0) + Number(activationRevenue._sum.amount ?? 0),
      invoicesNeedReview: reviewRecurring + reviewActivation,
      generatedAt: now,
    };
  }

  async revenue(query: PlatformRevenueQueryDto) {
    const { from, toExclusive, to } = this.resolveRange(query.from, query.to);
    const planFilter = query.planId ? { planId: query.planId } : {};
    const [
      subscriptionRows,
      registrationRows,
      subscriptions,
      manualRenewals,
      pendingRecurring,
      pendingActivation,
    ] = await Promise.all([
      this.prisma.subscriptionCheckout.findMany({
        where: {
          status: SubscriptionCheckoutStatus.PAID,
          paidAt: { gte: from, lt: toExclusive },
          ...planFilter,
        },
        select: {
          id: true,
          chainId: true,
          amount: true,
          paidAt: true,
          chain: { select: { name: true } },
          plan: { select: { id: true, name: true } },
        },
      }),
      this.prisma.registrationCheckout.findMany({
        where: {
          status: SubscriptionCheckoutStatus.PAID,
          paidAt: { gte: from, lt: toExclusive },
          ...planFilter,
        },
        select: {
          id: true,
          amount: true,
          paidAt: true,
          application: { select: { businessName: true, approvedChainId: true } },
          plan: { select: { id: true, name: true } },
        },
      }),
      this.prisma.businessSubscription.findMany({
        select: {
          status: true,
          expiresAt: true,
          monthlyPrice: true,
          trialStartedAt: true,
          trialConvertedAt: true,
          plan: { select: { code: true } },
        },
      }),
      this.prisma.businessSubscriptionEvent.count({
        where: {
          type: SubscriptionEventType.RENEWED,
          changedById: { not: null },
          effectiveAt: { gte: from, lt: toExclusive },
        },
      }),
      this.prisma.subscriptionCheckout.findMany({
        where: {
          status: {
            in: [SubscriptionCheckoutStatus.PENDING, SubscriptionCheckoutStatus.NEEDS_REVIEW],
          },
        },
        select: { amount: true, status: true },
      }),
      this.prisma.registrationCheckout.findMany({
        where: {
          status: {
            in: [SubscriptionCheckoutStatus.PENDING, SubscriptionCheckoutStatus.NEEDS_REVIEW],
          },
        },
        select: { amount: true, status: true },
      }),
    ]);

    const invoices: RevenueInvoice[] = [
      ...subscriptionRows.flatMap((row) =>
        row.paidAt
          ? [
              {
                source: 'SUBSCRIPTION' as const,
                id: row.id,
                businessId: row.chainId,
                businessName: row.chain.name,
                planId: row.plan.id,
                planName: row.plan.name,
                amount: Number(row.amount),
                paidAt: row.paidAt,
              },
            ]
          : [],
      ),
      ...registrationRows.flatMap((row) =>
        row.paidAt
          ? [
              {
                source: 'REGISTRATION' as const,
                id: row.id,
                businessId: row.application.approvedChainId,
                businessName: row.application.businessName,
                planId: row.plan.id,
                planName: row.plan.name,
                amount: Number(row.amount),
                paidAt: row.paidAt,
              },
            ]
          : [],
      ),
    ];

    const series = new Map<string, { revenue: number; invoiceCount: number }>();
    const byPlan = new Map<
      string,
      { planId: string; planName: string; revenue: number; invoiceCount: number }
    >();
    for (const invoice of invoices) {
      const bucket = this.bucket(invoice.paidAt, query.groupBy);
      const point = series.get(bucket) ?? { revenue: 0, invoiceCount: 0 };
      point.revenue += invoice.amount;
      point.invoiceCount += 1;
      series.set(bucket, point);

      const plan = byPlan.get(invoice.planId) ?? {
        planId: invoice.planId,
        planName: invoice.planName,
        revenue: 0,
        invoiceCount: 0,
      };
      plan.revenue += invoice.amount;
      plan.invoiceCount += 1;
      byPlan.set(invoice.planId, plan);
    }

    const now = new Date();
    const states = this.subscriptionStates(subscriptions, now);
    const trialBusinesses = subscriptions.filter((subscription) => subscription.trialStartedAt);
    const convertedTrials = trialBusinesses.filter(
      (subscription) => subscription.trialConvertedAt,
    ).length;
    const openInvoices = [...pendingRecurring, ...pendingActivation];

    return {
      range: { from: from.toISOString(), to: to.toISOString(), groupBy: query.groupBy },
      summary: {
        revenue: invoices.reduce((sum, invoice) => sum + invoice.amount, 0),
        invoiceCount: invoices.length,
        mrr: subscriptions
          .filter(
            (subscription) =>
              subscription.status === BusinessSubscriptionStatus.ACTIVE &&
              subscription.expiresAt > now &&
              subscription.plan.code !== 'TRIAL',
          )
          .reduce((sum, subscription) => sum + Number(subscription.monthlyPrice), 0),
        paidBusinesses: states.paid,
        trialBusinesses: states.trial,
        expiredBusinesses: states.expired,
        suspendedBusinesses: states.suspended,
        trialConversionRate: trialBusinesses.length ? convertedTrials / trialBusinesses.length : 0,
        unpaidInvoices: openInvoices.filter(
          (invoice) => invoice.status === SubscriptionCheckoutStatus.PENDING,
        ).length,
        reviewInvoices: openInvoices.filter(
          (invoice) => invoice.status === SubscriptionCheckoutStatus.NEEDS_REVIEW,
        ).length,
        outstandingAmount: openInvoices.reduce((sum, invoice) => sum + Number(invoice.amount), 0),
        manualRenewals,
      },
      series: [...series.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([period, value]) => ({ period, ...value })),
      plans: [...byPlan.values()].sort((a, b) => b.revenue - a.revenue),
    };
  }

  async listInvoices(query: ListPlatformInvoicesQueryDto) {
    const search = query.search?.trim();
    const recurringWhere: Prisma.SubscriptionCheckoutWhereInput = {
      status: query.status,
      chainId: query.chainId,
      ...(search
        ? {
            OR: [
              { providerOrderCode: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { chain: { name: { contains: search, mode: Prisma.QueryMode.insensitive } } },
              { chain: { code: { contains: search, mode: Prisma.QueryMode.insensitive } } },
            ],
          }
        : {}),
    };
    const registrationWhere: Prisma.RegistrationCheckoutWhereInput = {
      status: query.status,
      ...(query.chainId ? { application: { approvedChainId: query.chainId } } : {}),
      ...(search
        ? {
            OR: [
              { providerOrderCode: { contains: search, mode: Prisma.QueryMode.insensitive } },
              {
                application: {
                  businessName: { contains: search, mode: Prisma.QueryMode.insensitive },
                },
              },
              {
                application: {
                  applicationCode: { contains: search, mode: Prisma.QueryMode.insensitive },
                },
              },
            ],
          }
        : {}),
    };
    const [recurring, activations] = await Promise.all([
      this.prisma.subscriptionCheckout.findMany({
        where: recurringWhere,
        include: {
          chain: { select: { id: true, code: true, name: true } },
          plan: { select: { id: true, name: true } },
        },
      }),
      this.prisma.registrationCheckout.findMany({
        where: registrationWhere,
        include: {
          application: {
            select: { id: true, applicationCode: true, businessName: true, approvedChainId: true },
          },
          plan: { select: { id: true, name: true } },
        },
      }),
    ]);
    const rows = [
      ...recurring.map((row) => ({
        source: 'SUBSCRIPTION' as const,
        id: row.id,
        referenceCode: row.providerOrderCode,
        businessId: row.chain.id,
        businessCode: row.chain.code,
        businessName: row.chain.name,
        planId: row.plan.id,
        planName: row.plan.name,
        amount: Number(row.amount),
        status: row.status,
        paidAt: row.paidAt,
        reviewReason: row.reviewReason,
        createdAt: row.createdAt,
      })),
      ...activations.map((row) => ({
        source: 'REGISTRATION' as const,
        id: row.id,
        referenceCode: row.providerOrderCode,
        businessId: row.application.approvedChainId,
        businessCode: row.application.applicationCode,
        businessName: row.application.businessName,
        planId: row.plan.id,
        planName: row.plan.name,
        amount: Number(row.amount),
        status: row.status,
        paidAt: row.paidAt,
        reviewReason: row.reviewReason,
        createdAt: row.createdAt,
      })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const start = (query.page - 1) * query.limit;
    return {
      items: rows.slice(start, start + query.limit),
      pagination: {
        page: query.page,
        limit: query.limit,
        total: rows.length,
        totalPages: Math.ceil(rows.length / query.limit),
      },
    };
  }

  private resolveRange(fromText?: string, toText?: string) {
    const today = new Date();
    const toDate =
      toText ??
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(today);
    const fromDate =
      fromText ??
      (() => {
        const value = new Date(`${toDate}T00:00:00+07:00`);
        value.setUTCDate(value.getUTCDate() - 29);
        return new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Ho_Chi_Minh',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(value);
      })();
    const from = new Date(`${fromDate}T00:00:00+07:00`);
    const to = new Date(`${toDate}T00:00:00+07:00`);
    const toExclusive = new Date(to.getTime() + 86_400_000);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to)
      throw new BadRequestException('Invalid platform revenue date range');
    if (toExclusive.getTime() - from.getTime() > 366 * 86_400_000)
      throw new BadRequestException('Platform revenue range cannot exceed 366 days');
    return { from, to, toExclusive };
  }

  private bucket(date: Date, groupBy: PlatformRevenueQueryDto['groupBy']) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
        .formatToParts(date)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]),
    );
    if (groupBy === 'year') return parts.year;
    if (groupBy === 'month') return `${parts.year}-${parts.month}`;
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  private subscriptionStates(
    subscriptions: Array<{
      status: BusinessSubscriptionStatus;
      expiresAt: Date;
      plan: { code: string };
    }>,
    now: Date,
  ) {
    const result = { total: subscriptions.length, paid: 0, trial: 0, expired: 0, suspended: 0 };
    for (const subscription of subscriptions) {
      if (subscription.status === BusinessSubscriptionStatus.SUSPENDED) result.suspended += 1;
      else if (
        subscription.status === BusinessSubscriptionStatus.EXPIRED ||
        subscription.expiresAt <= now
      )
        result.expired += 1;
      else if (subscription.plan.code === 'TRIAL') result.trial += 1;
      else result.paid += 1;
    }
    return result;
  }
}
