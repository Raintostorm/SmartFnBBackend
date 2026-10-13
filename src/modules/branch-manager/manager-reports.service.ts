import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import type { ManagerReportQueryDto } from './manager.dto.js';
import { managerActor } from './manager-scope.js';

@Injectable()
export class ManagerReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BranchAccessService,
  ) {}

  async report(user: AuthenticatedUser, query: ManagerReportQueryDto) {
    const { branchId } = managerActor(user);
    await this.access.assertCanAccessBranch(user, branchId);
    const branch = await this.prisma.branch.findUniqueOrThrow({
      where: { id: branchId },
      select: { id: true, name: true, timezone: true },
    });
    const { from, to } = this.range(query, branch.timezone);
    const startAt = this.zonedMidnight(from, branch.timezone);
    const nextDate = new Date(`${to}T00:00:00.000Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    const endAt = this.zonedMidnight(nextDate.toISOString().slice(0, 10), branch.timezone);
    const bounds = Prisma.sql`bounds AS (SELECT ${startAt}::timestamptz AS start_at,
      ${endAt}::timestamptz AS end_at)`;
    const sales = Prisma.sql`sales AS (SELECT o.* FROM orders o, bounds b WHERE o.branch_id = ${branchId}::uuid
      AND o.payment_status = 'PAID' AND o.paid_at >= b.start_at AND o.paid_at < b.end_at)`;
    const result = await this.prisma.$transaction(
      async (tx) => {
        const [summary] = await tx.$queryRaw<
          Array<{
            grossRevenue: string;
            refundAmount: string;
            pendingRefundAmount: string;
            netRevenue: string;
            revenue: string;
            orderCount: number;
            averageOrderValue: string;
          }>
        >`
        WITH ${bounds}, ${sales}, refund_totals AS (
          SELECT COALESCE(SUM(r.amount),0) AS total,
            COALESCE(SUM(r.amount) FILTER (WHERE r.status = 'PENDING'),0) AS pending
          FROM refunds r JOIN orders o ON o.id = r.order_id, bounds b
          WHERE o.branch_id = ${branchId}::uuid AND r.cancellation_date >= ${from}::date
            AND r.cancellation_date <= ${to}::date
        ), sale_totals AS (
          SELECT COALESCE(SUM(total_amount),0) AS gross,
            COUNT(*) FILTER (WHERE status <> 'CANCELLED')::int AS orders FROM sales
        ) SELECT st.gross::text AS "grossRevenue",
          rt.total::text AS "refundAmount", rt.pending::text AS "pendingRefundAmount",
          (st.gross - rt.total)::text AS "netRevenue", (st.gross - rt.total)::text AS revenue,
          st.orders AS "orderCount",
          CASE WHEN st.orders = 0 THEN '0' ELSE ROUND((st.gross - rt.total) / st.orders, 2)::text END
            AS "averageOrderValue" FROM sale_totals st CROSS JOIN refund_totals rt`;
        const revenue = await tx.$queryRaw`
        WITH ${bounds}, ${sales}, buckets AS (
          SELECT generate_series(date_trunc(${query.granularity}, ${from}::date::timestamp),
            date_trunc(${query.granularity}, ${to}::date::timestamp), ('1 ' || ${query.granularity})::interval) AS bucket
        ), sale_totals AS (
          SELECT date_trunc(${query.granularity}, s.paid_at AT TIME ZONE ${branch.timezone}) AS bucket,
            SUM(s.total_amount) AS gross,
            COUNT(s.id) FILTER (WHERE s.status <> 'CANCELLED')::int AS orders
          FROM sales s GROUP BY 1
        ), refund_totals AS (
          SELECT date_trunc(${query.granularity}, r.cancellation_date::timestamp) AS bucket,
            SUM(r.amount) AS refunds FROM refunds r JOIN orders o ON o.id = r.order_id
          WHERE o.branch_id = ${branchId}::uuid AND r.cancellation_date >= ${from}::date
            AND r.cancellation_date <= ${to}::date GROUP BY 1
        ) SELECT to_char(b.bucket,'YYYY-MM-DD') AS bucket,
          COALESCE(s.gross,0)::text AS "grossRevenue", COALESCE(r.refunds,0)::text AS "refundAmount",
          (COALESCE(s.gross,0)-COALESCE(r.refunds,0))::text AS "netRevenue",
          (COALESCE(s.gross,0)-COALESCE(r.refunds,0))::text AS revenue,
          COALESCE(s.orders,0)::int AS "orderCount" FROM buckets b
          LEFT JOIN sale_totals s ON s.bucket = b.bucket LEFT JOIN refund_totals r ON r.bucket = b.bucket
          ORDER BY b.bucket`;
        const payments = await tx.$queryRaw`
        WITH ${bounds}, ${sales}, payment_totals AS (
          SELECT p.method, SUM(p.amount) AS gross_settled,
            SUM(COALESCE(p.received_amount,p.amount)) AS gross_received,
            COUNT(*) FILTER (WHERE po.status <> 'CANCELLED')::int AS successful_count,
            COUNT(*) FILTER (WHERE po.status = 'CANCELLED')::int AS cancelled_count
          FROM payments p JOIN sales po ON po.id = p.order_id, bounds b
          WHERE p.status = 'SUCCESS' AND p.paid_at >= b.start_at AND p.paid_at < b.end_at
          GROUP BY p.method
        ), refund_totals AS (
          SELECT p.method, SUM(r.amount) AS refunds
          FROM refunds r JOIN payments p ON p.id = r.payment_id JOIN orders o ON o.id = r.order_id
          WHERE o.branch_id = ${branchId}::uuid AND r.cancellation_date >= ${from}::date
            AND r.cancellation_date <= ${to}::date GROUP BY p.method
        ) SELECT COALESCE(p.method,r.method) AS method,
          COALESCE(p.gross_settled,0)::text AS "grossSettledAmount",
          (COALESCE(p.gross_settled,0)-COALESCE(r.refunds,0))::text AS "settledAmount",
          COALESCE(p.gross_received,0)::text AS "grossReceivedAmount",
          (COALESCE(p.gross_received,0)-COALESCE(r.refunds,0))::text AS "receivedAmount",
          COALESCE(r.refunds,0)::text AS "refundAmount",
          (COALESCE(p.gross_settled,0)-COALESCE(r.refunds,0))::text AS "netAmount",
          COALESCE(p.successful_count,0)::int AS "paymentCount",
          COALESCE(p.cancelled_count,0)::int AS "cancelledAfterPaymentCount"
        FROM payment_totals p FULL OUTER JOIN refund_totals r ON r.method=p.method
        ORDER BY COALESCE(p.method,r.method)`;
        const topItems = await tx.$queryRaw`
        WITH ${bounds}, ${sales} SELECT i.menu_item_id AS "menuItemId", i.item_name AS name,
          SUM(i.quantity)::int AS quantity, SUM(i.total_price)::text AS "lineRevenue"
        FROM order_items i JOIN sales s ON s.id = i.order_id WHERE i.status <> 'CANCELLED'
        GROUP BY i.menu_item_id, i.item_name ORDER BY SUM(i.quantity) DESC, i.menu_item_id LIMIT ${query.limit}`;
        const topOptions = await tx.$queryRaw`
        WITH ${bounds}, ${sales} SELECT opt->>'id' AS "optionId", opt->>'name' AS name,
          opt->>'groupCode' AS "groupCode", opt->>'groupName' AS "groupName",
          SUM(i.quantity)::int AS quantity,
          SUM(i.quantity * COALESCE((opt->>'priceDelta')::numeric,0))::text AS "additionalRevenue"
        FROM order_items i JOIN sales s ON s.id = i.order_id
          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(i.selected_options) = 'array' THEN i.selected_options ELSE '[]'::jsonb END) opt
        WHERE i.status <> 'CANCELLED'
        GROUP BY opt->>'id',opt->>'name',opt->>'groupCode',opt->>'groupName'
        ORDER BY SUM(i.quantity) DESC,opt->>'id' LIMIT ${query.limit}`;
        const topToppings = await tx.$queryRaw`
        WITH ${bounds}, ${sales} SELECT opt->>'id' AS "optionId", opt->>'name' AS name,
          SUM(i.quantity)::int AS quantity, SUM(i.quantity * COALESCE((opt->>'priceDelta')::numeric,0))::text AS "additionalRevenue"
        FROM order_items i JOIN sales s ON s.id = i.order_id
          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(i.selected_options) = 'array' THEN i.selected_options ELSE '[]'::jsonb END) opt
        WHERE i.status <> 'CANCELLED' AND upper(opt->>'groupCode') IN ('TOPPING','TOPPINGS')
        GROUP BY opt->>'id',opt->>'name' ORDER BY SUM(i.quantity) DESC,opt->>'id' LIMIT ${query.limit}`;
        const ordersByHour = await tx.$queryRaw`
        WITH ${bounds}, ${sales}, counts AS (
          SELECT EXTRACT(HOUR FROM s.placed_at AT TIME ZONE ${branch.timezone})::int AS hour,
            COUNT(*)::int AS total FROM sales s WHERE s.status <> 'CANCELLED' GROUP BY 1)
        SELECT h AS hour,COALESCE(c.total,0)::int AS "orderCount" FROM generate_series(0,23) h LEFT JOIN counts c ON c.hour = h ORDER BY h`;
        const [preparation] = await tx.$queryRaw<
          Array<{ averageSeconds: number | null; completedUnits: number }>
        >`
        WITH ${bounds}, durations AS (
          SELECT EXTRACT(EPOCH FROM (u.completed_at - u.started_at)) AS seconds FROM order_item_units u
          JOIN order_items i ON i.id = u.order_item_id JOIN orders o ON o.id = i.order_id, bounds b
          WHERE o.branch_id = ${branchId}::uuid AND u.completed_at >= b.start_at AND u.completed_at < b.end_at
            AND u.started_at IS NOT NULL AND u.completed_at >= u.started_at AND u.status <> 'CANCELLED' AND o.status <> 'CANCELLED'
          UNION ALL
          SELECT EXTRACT(EPOCH FROM (i.completed_at - i.started_at)) FROM order_items i JOIN orders o ON o.id = i.order_id, bounds b
          WHERE o.branch_id = ${branchId}::uuid AND i.completed_at >= b.start_at AND i.completed_at < b.end_at
            AND i.started_at IS NOT NULL AND i.completed_at >= i.started_at AND i.status <> 'CANCELLED' AND o.status <> 'CANCELLED'
            AND NOT EXISTS (SELECT 1 FROM order_item_units u WHERE u.order_item_id = i.id)
        ) SELECT ROUND(AVG(seconds),2)::float8 AS "averageSeconds", COUNT(*)::int AS "completedUnits" FROM durations`;
        const [cancellations] = await tx.$queryRaw<
          Array<{
            total: number;
            paidCancellationCount: number;
            refundAmount: string;
            pendingRefundAmount: string;
          }>
        >`
        WITH ${bounds}, cancelled AS (
          SELECT COUNT(*)::int AS total FROM orders o,bounds b WHERE o.branch_id=${branchId}::uuid
            AND o.status='CANCELLED' AND o.cancelled_at>=b.start_at AND o.cancelled_at<b.end_at
        ), paid AS (
          SELECT COUNT(DISTINCT r.order_id)::int AS count, COALESCE(SUM(r.amount),0) AS refunds,
            COALESCE(SUM(r.amount) FILTER (WHERE r.status='PENDING'),0) AS pending
          FROM refunds r JOIN orders o ON o.id=r.order_id WHERE o.branch_id=${branchId}::uuid
            AND r.cancellation_date>=${from}::date AND r.cancellation_date<=${to}::date
        ) SELECT c.total,p.count AS "paidCancellationCount",p.refunds::text AS "refundAmount",
          p.pending::text AS "pendingRefundAmount" FROM cancelled c CROSS JOIN paid p`;
        const cancelledOrders = await tx.$queryRaw`
        WITH ${bounds} SELECT o.id,o.order_code AS "orderCode",o.call_number AS "callNumber",o.total_amount::text AS "totalAmount",
          o.cancelled_at AS "cancelledAt",o.cancellation_reason AS reason,o.cancelled_by_id AS "cancelledById",
          COALESCE((SELECT SUM(r.amount) FROM refunds r WHERE r.order_id=o.id),0)::text AS "refundAmount"
        FROM orders o,bounds b WHERE o.branch_id = ${branchId}::uuid AND o.status = 'CANCELLED'
          AND o.cancelled_at >= b.start_at AND o.cancelled_at < b.end_at ORDER BY o.cancelled_at DESC,o.id LIMIT ${query.limit}`;
        return {
          summary,
          revenue,
          payments,
          topItems,
          topOptions,
          topToppings,
          ordersByHour,
          preparation,
          cancellations: { ...cancellations, items: cancelledOrders, limit: query.limit },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 },
    );
    return {
      branch,
      range: { from, to, timezone: branch.timezone, granularity: query.granularity },
      ...result,
    };
  }

  private range(query: ManagerReportQueryDto, timezone: string) {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const to = query.to ?? today;
    const fallback = new Date(`${to}T00:00:00Z`);
    if (Number.isNaN(fallback.getTime())) throw new BadRequestException('Invalid report date');
    fallback.setUTCDate(fallback.getUTCDate() - 29);
    const from = query.from ?? fallback.toISOString().slice(0, 10);
    for (const date of [from, to]) {
      const value = new Date(`${date}T00:00:00Z`);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        Number.isNaN(value.getTime()) ||
        value.toISOString().slice(0, 10) !== date
      )
        throw new BadRequestException('Use valid YYYY-MM-DD dates');
    }
    const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
    if (days < 1 || days > 366)
      throw new BadRequestException('Report range must contain 1 to 366 days');
    return { from, to };
  }

  private zonedMidnight(date: string, timezone: string) {
    const [year, month, day] = date.split('-').map(Number);
    const desired = Date.UTC(year, month - 1, day);
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    let instant = desired;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const parts = Object.fromEntries(
        formatter
          .formatToParts(new Date(instant))
          .filter((part) => part.type !== 'literal')
          .map((part) => [part.type, Number(part.value)]),
      );
      const represented = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
      );
      instant += desired - represented;
    }
    return new Date(instant);
  }
}
