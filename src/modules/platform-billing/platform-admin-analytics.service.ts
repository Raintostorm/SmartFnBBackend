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
import { PlatformRevenueGroupBy } from '../platform-admin/dto/platform-admin.dto.js';

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
    // "Tháng này" theo giờ Việt Nam (UTC+7): 00:00 ngày 1 giờ VN = 17:00 UTC của ngày cuối tháng trước.
    const vnNow = new Date(now.getTime() + 7 * 3_600_000);
    const monthStart = new Date(Date.UTC(vnNow.getUTCFullYear(), vnNow.getUTCMonth(), 1) - 7 * 3_600_000);
    const [
      registrationGroups,
      subscriptions,
      plans,
      recurringRevenue,
      activationRevenue,
      reviewRecurring,
      reviewActivation,
      unpaidRecurring,
      unpaidActivation,
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
      // PA-06 "hoá đơn chưa trả": hiện ở Tổng quan như việc cần xử lý, kèm số tiền còn phải thu.
      this.prisma.subscriptionCheckout.aggregate({
        where: { status: SubscriptionCheckoutStatus.PENDING },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      this.prisma.registrationCheckout.aggregate({
        where: { status: SubscriptionCheckoutStatus.PENDING },
        _count: { _all: true },
        _sum: { amount: true },
      }),
    ]);

    const registrationCounts = Object.fromEntries(
      Object.values(RegistrationApplicationStatus).map((status) => [status, 0]),
    ) as Record<RegistrationApplicationStatus, number>;
    for (const row of registrationGroups) registrationCounts[row.status] = row._count._all;

    const states = this.subscriptionStates(subscriptions, now);
    const mrr = await this.mrrAt(now);

    return {
      registrations: registrationCounts,
      businesses: states,
      activePlans: plans,
      mrr,
      revenueThisMonth:
        Number(recurringRevenue._sum.amount ?? 0) + Number(activationRevenue._sum.amount ?? 0),
      invoicesNeedReview: reviewRecurring + reviewActivation,
      unpaidInvoices: (unpaidRecurring._count?._all ?? 0) + (unpaidActivation._count?._all ?? 0),
      outstandingAmount: Number(unpaidRecurring._sum?.amount ?? 0) + Number(unpaidActivation._sum?.amount ?? 0),
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
          trialEndsAt: true,
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
    // 30.4: MRR is read at the END of the viewed range (or now, if the range reaches today).
    const mrrAt = toExclusive.getTime() > now.getTime() ? now : new Date(toExclusive.getTime() - 1);
    const mrr = await this.mrrAt(mrrAt);
    // 30.4: trial conversion by the month the trial STARTED, for trials started in the range.
    // Trials still running and not converted are reported apart so an immature cohort is visible.
    const cohorts = new Map<string, { month: string; started: number; converted: number; inTrial: number }>();
    for (const subscription of subscriptions) {
      const startedAt = subscription.trialStartedAt;
      if (!startedAt || startedAt < from || startedAt >= toExclusive) continue;
      const month = this.bucket(startedAt, PlatformRevenueGroupBy.MONTH);
      const cohort = cohorts.get(month) ?? { month, started: 0, converted: 0, inTrial: 0 };
      cohort.started += 1;
      if (subscription.trialConvertedAt) cohort.converted += 1;
      else if (subscription.trialEndsAt && subscription.trialEndsAt > now) cohort.inTrial += 1;
      cohorts.set(month, cohort);
    }
    const trialCohorts = [...cohorts.values()]
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((cohort) => ({
        ...cohort,
        conversionRate: cohort.started ? cohort.converted / cohort.started : 0,
        // Only trials that have finished can still be judged; excludes the ones in progress.
        settledConversionRate: cohort.started - cohort.inTrial > 0 ? cohort.converted / (cohort.started - cohort.inTrial) : null,
      }));
    const trialStarted = trialCohorts.reduce((sum, c) => sum + c.started, 0);
    const trialConverted = trialCohorts.reduce((sum, c) => sum + c.converted, 0);
    const trialInProgress = trialCohorts.reduce((sum, c) => sum + c.inTrial, 0);
    const openInvoices = [...pendingRecurring, ...pendingActivation];

    return {
      range: { from: from.toISOString(), to: to.toISOString(), groupBy: query.groupBy },
      summary: {
        revenue: invoices.reduce((sum, invoice) => sum + invoice.amount, 0),
        invoiceCount: invoices.length,
        mrr,
        mrrAt: mrrAt.toISOString(),
        paidBusinesses: states.paid,
        trialBusinesses: states.trial,
        expiredBusinesses: states.expired,
        suspendedBusinesses: states.suspended,
        trialConversionRate: trialStarted ? trialConverted / trialStarted : 0,
        trialStarted,
        trialConverted,
        trialInProgress,
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
      trialCohorts,
    };
  }

  /**
   * MRR at instant `at` (30.4): monthly plan price + add-ons (extra branches, account packs) of every
   * paid period covering `at`, from the period snapshots so later price changes do not rewrite history.
   * Trials and businesses suspended at that time are excluded. Periods are the billing source of truth;
   * a subscription with no period row (created before periods existed) falls back to its current price
   * only when `at` is now.
   */
  private async mrrAt(at: Date) {
    const [periods, subscriptions] = await Promise.all([
      this.prisma.subscriptionPeriod.findMany({
        where: { startsAt: { lte: at }, endsAt: { gt: at }, planCode: { not: 'TRIAL' } },
        select: {
          subscriptionId: true, monthlyPrice: true, extraBranches: true, extraBranchPrice: true,
          accountPacks: true, accountPackPrice: true,
          subscription: { select: { status: true, suspendedAt: true } },
        },
      }),
      Math.abs(Date.now() - at.getTime()) < 60_000
        ? this.prisma.businessSubscription.findMany({
            where: { status: BusinessSubscriptionStatus.ACTIVE, expiresAt: { gt: at }, plan: { code: { not: 'TRIAL' } }, periods: { none: {} } },
            select: { monthlyPrice: true, activeExtraBranches: true, activeAccountPacks: true, plan: { select: { extraBranchPrice: true, extraAccountPackPrice: true } } },
          })
        : Promise.resolve([]),
    ]);
    const counted = new Set<string>();
    let total = 0;
    for (const period of periods) {
      if (counted.has(period.subscriptionId)) continue;
      const suspended = period.subscription.status === BusinessSubscriptionStatus.SUSPENDED && period.subscription.suspendedAt && period.subscription.suspendedAt <= at;
      if (suspended) continue;
      counted.add(period.subscriptionId);
      total += period.monthlyPrice + period.extraBranches * period.extraBranchPrice + period.accountPacks * period.accountPackPrice;
    }
    for (const legacy of subscriptions)
      total += Number(legacy.monthlyPrice) + legacy.activeExtraBranches * legacy.plan.extraBranchPrice + legacy.activeAccountPacks * legacy.plan.extraAccountPackPrice;
    return total;
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
