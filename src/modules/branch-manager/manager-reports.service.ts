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
    const bounds = Prisma.sql`bounds AS (SELECT ${from}::date::timestamp AT TIME ZONE ${branch.timezone} AS start_at,
      (${to}::date + 1)::timestamp AT TIME ZONE ${branch.timezone} AS end_at)`;
    const sales = Prisma.sql`sales AS (SELECT o.* FROM orders o, bounds b WHERE o.branch_id = ${branchId}::uuid
      AND o.payment_status = 'PAID' AND o.status <> 'CANCELLED' AND o.paid_at >= b.start_at AND o.paid_at < b.end_at)`;
    const result = await this.prisma.$transaction(
      async (tx) => {
        const [summary] = await tx.$queryRaw<
          Array<{ revenue: string; orderCount: number; averageOrderValue: string }>
        >`
        WITH ${bounds}, ${sales}
        SELECT COALESCE(SUM(total_amount),0)::text AS revenue, COUNT(*)::int AS "orderCount",
          COALESCE(ROUND(AVG(total_amount),2),0)::text AS "averageOrderValue" FROM sales`;
        const revenue = await tx.$queryRaw`
        WITH ${bounds}, ${sales}, buckets AS (
          SELECT generate_series(date_trunc(${query.granularity}, ${from}::date::timestamp),
            date_trunc(${query.granularity}, ${to}::date::timestamp), ('1 ' || ${query.granularity})::interval) AS bucket
        ) SELECT to_char(b.bucket,'YYYY-MM-DD') AS bucket, COALESCE(SUM(s.total_amount),0)::text AS revenue,
          COUNT(s.id)::int AS "orderCount" FROM buckets b
          LEFT JOIN sales s ON date_trunc(${query.granularity}, s.paid_at AT TIME ZONE ${branch.timezone}) = b.bucket
          GROUP BY b.bucket ORDER BY b.bucket`;
        const payments = await tx.$queryRaw`
        WITH ${bounds} SELECT p.method, SUM(p.amount)::text AS "settledAmount",
          SUM(COALESCE(p.received_amount,p.amount))::text AS "receivedAmount", COUNT(*)::int AS "paymentCount"
        FROM payments p, bounds b WHERE p.status = 'SUCCESS' AND p.paid_at >= b.start_at AND p.paid_at < b.end_at
          AND (EXISTS (SELECT 1 FROM orders o WHERE o.id = p.order_id AND o.branch_id = ${branchId}::uuid AND o.status <> 'CANCELLED')
            OR EXISTS (SELECT 1 FROM table_sessions s WHERE s.id = p.table_session_id AND s.branch_id = ${branchId}::uuid))
        GROUP BY p.method ORDER BY p.method`;
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
        WITH ${bounds}, counts AS (SELECT EXTRACT(HOUR FROM o.placed_at AT TIME ZONE ${branch.timezone})::int AS hour,
          COUNT(*)::int AS total FROM orders o,bounds b WHERE o.branch_id = ${branchId}::uuid AND o.placed_at >= b.start_at AND o.placed_at < b.end_at GROUP BY 1)
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
        const [cancellations] = await tx.$queryRaw<Array<{ total: number }>>`
        WITH ${bounds} SELECT COUNT(*)::int AS total FROM orders o,bounds b WHERE o.branch_id = ${branchId}::uuid
          AND o.status = 'CANCELLED' AND o.cancelled_at >= b.start_at AND o.cancelled_at < b.end_at`;
        const cancelledOrders = await tx.$queryRaw`
        WITH ${bounds} SELECT o.id,o.order_code AS "orderCode",o.call_number AS "callNumber",o.total_amount::text AS "totalAmount",
          o.cancelled_at AS "cancelledAt",o.cancellation_reason AS reason,o.cancelled_by_id AS "cancelledById"
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
}
