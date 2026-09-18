import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import {
  OrderItemStatus,
  OrderStatus,
  Prisma,
  TableSessionStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AppRole } from '../auth/app-role.enum.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import {
  ReportGranularity,
  type ReportRangeQueryDto,
  type RevenueTimeseriesQueryDto,
  type TopItemsQueryDto,
} from './dto/report.dto.js';

const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 366;
const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';

/** date_trunc takes a literal, so the granularity is mapped, never interpolated. */
const TRUNC_UNIT: Record<ReportGranularity, string> = {
  [ReportGranularity.DAY]: 'day',
  [ReportGranularity.WEEK]: 'week',
  [ReportGranularity.MONTH]: 'month',
};

export interface BranchRef {
  id: string;
  code: string;
  name: string;
  city: string;
  chainId: string;
}

interface ReportScope {
  branches: BranchRef[];
  branchIds: string[];
  /** Inclusive local start date, YYYY-MM-DD in `timezone`. */
  fromDate: string;
  /** Inclusive local end date, YYYY-MM-DD in `timezone`. */
  toDate: string;
  /** UTC instant of local midnight on fromDate. */
  from: Date;
  /** UTC instant of local midnight after toDate, exclusive. */
  to: Date;
  timezone: string;
}

interface TimeseriesRow {
  branch_id: string;
  /** Already formatted as YYYY-MM-DD by Postgres, so no driver timezone guessing. */
  bucket: string;
  order_count: bigint;
  revenue: string;
}

/**
 * Owner-facing sales reporting. Every figure is comparable across branches on one
 * axis, because comparing branches is the whole reason this exists.
 *
 * Revenue counts orders in status COMPLETED and is placed on the time axis by
 * placedAt, which is indexed and never null. Both the range filter and the
 * bucketing run in the chain timezone, so an evening order never lands in the
 * next day's bucket. There is no profit reporting: the platform tracks neither
 * stock nor payroll, so it has no cost side.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  /** Revenue side by side per branch, for the single comparison chart. */
  async compareBranches(user: AuthenticatedUser, query: ReportRangeQueryDto) {
    const scope = await this.resolveScope(user, query);
    if (scope.branchIds.length === 0) {
      return this.emptyReport(scope);
    }

    const [revenueRows, guestRows] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['branchId'],
        where: this.completedOrdersWhere(scope),
        _sum: { totalAmount: true, discountAmount: true },
        _count: { _all: true },
      }),
      this.prisma.tableSession.groupBy({
        by: ['branchId'],
        where: this.servedSessionsWhere(scope),
        _sum: { guestCount: true },
        _count: { _all: true },
      }),
    ]);

    const revenueByBranch = new Map(revenueRows.map((row) => [row.branchId, row]));
    const guestsByBranch = new Map(guestRows.map((row) => [row.branchId, row]));

    const branches = scope.branches.map((branch) => {
      const revenue = revenueByBranch.get(branch.id);
      const guests = guestsByBranch.get(branch.id);
      const totalRevenue = revenue?._sum.totalAmount ?? new Prisma.Decimal(0);
      const orderCount = revenue?._count._all ?? 0;

      return {
        branch,
        revenue: this.money(totalRevenue),
        discount: this.money(revenue?._sum.discountAmount ?? new Prisma.Decimal(0)),
        orderCount,
        averageOrderValue: this.money(
          orderCount > 0 ? totalRevenue.dividedBy(orderCount) : new Prisma.Decimal(0),
        ),
        guestCount: guests?._sum.guestCount ?? 0,
        sessionCount: guests?._count._all ?? 0,
      };
    });

    branches.sort((left, right) => Number(right.revenue) - Number(left.revenue));

    return {
      range: this.describeRange(scope),
      totals: {
        revenue: this.sumMoney(branches.map(({ revenue }) => revenue)),
        orderCount: branches.reduce((total, { orderCount }) => total + orderCount, 0),
        guestCount: branches.reduce((total, { guestCount }) => total + guestCount, 0),
      },
      branches,
    };
  }

  /** One series per branch over time, so the branches share a single chart axis. */
  async getRevenueTimeseries(user: AuthenticatedUser, query: RevenueTimeseriesQueryDto) {
    const scope = await this.resolveScope(user, query);
    if (scope.branchIds.length === 0) {
      return { ...this.emptyReport(scope), granularity: query.granularity, buckets: [] };
    }

    const unit = TRUNC_UNIT[query.granularity];
    const rows = await this.prisma.$queryRaw<TimeseriesRow[]>`
      SELECT
        o."branch_id" AS branch_id,
        to_char(
          date_trunc(${unit}, o."placed_at" AT TIME ZONE ${scope.timezone}),
          'YYYY-MM-DD'
        ) AS bucket,
        COUNT(*) AS order_count,
        COALESCE(SUM(o."total_amount"), 0)::text AS revenue
      FROM "orders" o
      WHERE o."branch_id" = ANY(${scope.branchIds}::uuid[])
        AND o."status" = ${OrderStatus.COMPLETED}::"OrderStatus"
        AND o."placed_at" >= ${scope.from}
        AND o."placed_at" < ${scope.to}
      GROUP BY 1, 2
      ORDER BY 2 ASC, 1 ASC
    `;

    const bucketKeys = this.buildBucketKeys(scope, query.granularity);
    const byBranch = new Map<string, Map<string, TimeseriesRow>>();
    for (const row of rows) {
      const series = byBranch.get(row.branch_id) ?? new Map<string, TimeseriesRow>();
      series.set(row.bucket, row);
      byBranch.set(row.branch_id, series);
    }

    return {
      range: this.describeRange(scope),
      granularity: query.granularity,
      // A shared, gap-filled bucket list keeps every series aligned on the chart.
      buckets: bucketKeys,
      series: scope.branches.map((branch) => {
        const series = byBranch.get(branch.id);
        const points = bucketKeys.map((bucket) => {
          const row = series?.get(bucket);
          return {
            bucket,
            revenue: row ? this.money(new Prisma.Decimal(row.revenue)) : '0.00',
            orderCount: row ? Number(row.order_count) : 0,
          };
        });
        return {
          branch,
          points,
          total: this.sumMoney(points.map(({ revenue }) => revenue)),
          orderCount: points.reduce((total, { orderCount }) => total + orderCount, 0),
        };
      }),
    };
  }

  /** Best sellers over the whole scope, with the per-branch split behind each item. */
  async getTopItems(user: AuthenticatedUser, query: TopItemsQueryDto) {
    const scope = await this.resolveScope(user, query);
    if (scope.branchIds.length === 0) {
      return { ...this.emptyReport(scope), items: [] };
    }

    const where: Prisma.OrderItemWhereInput = {
      status: { not: OrderItemStatus.CANCELLED },
      order: this.completedOrdersWhere(scope),
    };

    const grouped = await this.prisma.orderItem.groupBy({
      by: ['menuItemId'],
      where,
      _sum: { quantity: true, totalPrice: true },
      _count: { _all: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: query.limit,
    });

    const menuItems = await this.prisma.menuItem.findMany({
      where: { id: { in: grouped.map(({ menuItemId }) => menuItemId) } },
      select: {
        id: true,
        sku: true,
        name: true,
        price: true,
        imageUrl: true,
        isActive: true,
        category: { select: { id: true, name: true } },
      },
    });
    const menuItemById = new Map(menuItems.map((item) => [item.id, item]));

    return {
      range: this.describeRange(scope),
      items: grouped.map((row, index) => ({
        rank: index + 1,
        menuItem: menuItemById.get(row.menuItemId) ?? { id: row.menuItemId },
        quantity: row._sum.quantity ?? 0,
        revenue: this.money(row._sum.totalPrice ?? new Prisma.Decimal(0)),
        orderLineCount: row._count._all,
      })),
    };
  }

  /** Guests served per branch, from the table sessions that reached payment. */
  async getCustomerTraffic(user: AuthenticatedUser, query: ReportRangeQueryDto) {
    const scope = await this.resolveScope(user, query);
    if (scope.branchIds.length === 0) {
      return this.emptyReport(scope);
    }

    const rows = await this.prisma.tableSession.groupBy({
      by: ['branchId'],
      where: this.servedSessionsWhere(scope),
      _sum: { guestCount: true },
      _count: { _all: true },
      _avg: { guestCount: true },
    });
    const byBranch = new Map(rows.map((row) => [row.branchId, row]));

    const branches = scope.branches.map((branch) => {
      const row = byBranch.get(branch.id);
      return {
        branch,
        guestCount: row?._sum.guestCount ?? 0,
        sessionCount: row?._count._all ?? 0,
        averageGuestsPerSession: Number((row?._avg.guestCount ?? 0).toFixed(2)),
      };
    });

    return {
      range: this.describeRange(scope),
      totals: {
        guestCount: branches.reduce((total, { guestCount }) => total + guestCount, 0),
        sessionCount: branches.reduce((total, { sessionCount }) => total + sessionCount, 0),
      },
      branches,
    };
  }

  // --- Scope and range ------------------------------------------------------

  private async resolveScope(
    user: AuthenticatedUser,
    query: ReportRangeQueryDto,
  ): Promise<ReportScope> {
    if (user.role !== AppRole.OWNER) {
      throw new ForbiddenException('Only OWNER can read chain reports');
    }

    const accessibleBranchIds = await this.branchAccess.getAccessibleBranchIds(user);
    const allowed = new Set(accessibleBranchIds ?? []);

    if (query.branchIds?.length) {
      const outside = query.branchIds.filter((id) => !allowed.has(id));
      if (outside.length > 0) {
        throw new ForbiddenException(
          `These branches are outside your scope: ${outside.join(', ')}`,
        );
      }
    }

    const branches = await this.prisma.branch.findMany({
      where: {
        id: { in: query.branchIds?.length ? query.branchIds : [...allowed] },
        chainId: query.chainId,
        deletedAt: null,
      },
      select: {
        id: true,
        code: true,
        name: true,
        city: true,
        chainId: true,
        chain: { select: { timezone: true } },
      },
      orderBy: [{ city: 'asc' }, { name: 'asc' }],
    });

    // Chains are single-timezone in practice; the first one drives the buckets.
    const timezone = branches[0]?.chain.timezone ?? DEFAULT_TIMEZONE;

    return {
      branches: branches.map(({ chain: _chain, ...branch }) => branch),
      branchIds: branches.map(({ id }) => id),
      timezone,
      ...this.resolveRange(query, timezone),
    };
  }

  /**
   * Both bounds are local dates in the chain timezone. "to" is inclusive for the
   * caller, so the exclusive instant is local midnight after it.
   */
  private resolveRange(query: ReportRangeQueryDto, timezone: string) {
    const toDate = query.to
      ? this.parseLocalDate(query.to, 'to')
      : this.localDateOf(new Date(), timezone);
    const fromDate = query.from
      ? this.parseLocalDate(query.from, 'from')
      : this.shiftLocalDate(toDate, -(DEFAULT_RANGE_DAYS - 1));

    if (fromDate > toDate) {
      throw new BadRequestException('"from" must be earlier than "to"');
    }
    const rangeDays = this.daysBetween(fromDate, toDate) + 1;
    if (rangeDays > MAX_RANGE_DAYS) {
      throw new BadRequestException(`The reporting range cannot exceed ${MAX_RANGE_DAYS} days`);
    }

    return {
      fromDate,
      toDate,
      from: this.zonedStartOfDay(fromDate, timezone),
      to: this.zonedStartOfDay(this.shiftLocalDate(toDate, 1), timezone),
    };
  }

  private parseLocalDate(value: string, field: string): string {
    const date = value.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00.000Z`))) {
      throw new BadRequestException(`"${field}" must use YYYY-MM-DD format`);
    }
    return date;
  }

  /** The calendar date an instant falls on, in the given timezone. */
  private localDateOf(instant: Date, timezone: string): string {
    const parts = this.zonedParts(instant, timezone);
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  /** The UTC instant of local midnight starting `date` in `timezone`. */
  private zonedStartOfDay(date: string, timezone: string): Date {
    const asUtc = new Date(`${date}T00:00:00.000Z`);
    // Measure the offset at the guess, then again at the corrected instant so a
    // DST boundary between the two settles on the right side.
    const guess = new Date(asUtc.getTime() - this.zoneOffsetMs(asUtc, timezone));
    return new Date(asUtc.getTime() - this.zoneOffsetMs(guess, timezone));
  }

  /** How far ahead of UTC `timezone` is at `instant`, in milliseconds. */
  private zoneOffsetMs(instant: Date, timezone: string): number {
    const parts = this.zonedParts(instant, timezone);
    const localAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    return localAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
  }

  private zonedParts(instant: Date, timezone: string): Record<string, string> {
    const options: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    };
    let formatter: Intl.DateTimeFormat;
    try {
      formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: timezone });
    } catch {
      throw new BadRequestException(`Unknown chain timezone: ${timezone}`);
    }
    return Object.fromEntries(
      formatter.formatToParts(instant).map(({ type, value }) => [type, value]),
    );
  }

  // --- Local date arithmetic (date-only, so no timezone is involved) --------

  private shiftLocalDate(date: string, days: number): string {
    const shifted = new Date(`${date}T00:00:00.000Z`);
    shifted.setUTCDate(shifted.getUTCDate() + days);
    return shifted.toISOString().slice(0, 10);
  }

  private daysBetween(from: string, to: string): number {
    const start = Date.parse(`${from}T00:00:00.000Z`);
    const end = Date.parse(`${to}T00:00:00.000Z`);
    return Math.round((end - start) / (24 * 60 * 60 * 1000));
  }

  /**
   * Every bucket the range covers, including the ones with no sales, so a gap in
   * trading does not become a gap in the chart. Aligned with Postgres date_trunc:
   * weeks start on Monday, months on the 1st.
   */
  private buildBucketKeys(scope: ReportScope, granularity: ReportGranularity): string[] {
    const keys: string[] = [];
    let cursor = this.truncateLocalDate(scope.fromDate, granularity);

    while (cursor <= scope.toDate) {
      keys.push(cursor);
      cursor = this.advanceLocalDate(cursor, granularity);
    }
    return keys;
  }

  private truncateLocalDate(date: string, granularity: ReportGranularity): string {
    if (granularity === ReportGranularity.MONTH) {
      return `${date.slice(0, 7)}-01`;
    }
    if (granularity === ReportGranularity.WEEK) {
      const parsed = new Date(`${date}T00:00:00.000Z`);
      // getUTCDay is 0 for Sunday; Postgres weeks start on Monday.
      const daysSinceMonday = (parsed.getUTCDay() + 6) % 7;
      return this.shiftLocalDate(date, -daysSinceMonday);
    }
    return date;
  }

  private advanceLocalDate(date: string, granularity: ReportGranularity): string {
    if (granularity === ReportGranularity.MONTH) {
      const next = new Date(`${date}T00:00:00.000Z`);
      next.setUTCMonth(next.getUTCMonth() + 1);
      return next.toISOString().slice(0, 10);
    }
    return this.shiftLocalDate(date, granularity === ReportGranularity.WEEK ? 7 : 1);
  }

  // --- Shared filters and formatting ---------------------------------------

  private completedOrdersWhere(scope: ReportScope): Prisma.OrderWhereInput {
    return {
      branchId: { in: scope.branchIds },
      status: OrderStatus.COMPLETED,
      placedAt: { gte: scope.from, lt: scope.to },
    };
  }

  private servedSessionsWhere(scope: ReportScope): Prisma.TableSessionWhereInput {
    return {
      branchId: { in: scope.branchIds },
      status: { in: [TableSessionStatus.PAID, TableSessionStatus.CLOSED] },
      openedAt: { gte: scope.from, lt: scope.to },
    };
  }

  private describeRange(scope: ReportScope) {
    return {
      from: scope.fromDate,
      to: scope.toDate,
      timezone: scope.timezone,
      branchCount: scope.branchIds.length,
    };
  }

  private emptyReport(scope: ReportScope) {
    return {
      range: this.describeRange(scope),
      totals: { revenue: '0.00', orderCount: 0, guestCount: 0, sessionCount: 0 },
      branches: [],
    };
  }

  /** Money leaves as a fixed-scale string so no precision is lost in JSON. */
  private money(value: Prisma.Decimal): string {
    return value.toFixed(2);
  }

  private sumMoney(values: string[]): string {
    return values
      .reduce((total, value) => total.plus(new Prisma.Decimal(value)), new Prisma.Decimal(0))
      .toFixed(2);
  }
}
