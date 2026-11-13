import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { RealtimePublisher } from '../../realtime/realtime.publisher.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';

@Injectable()
export class PagersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BranchAccessService,
    private readonly realtime: RealtimePublisher,
  ) {}

  async change(
    user: AuthenticatedUser,
    orderId: string,
    pagerNumber: number | null,
    notify = false,
  ) {
    const roles = notify ? ['CASHIER', 'BARISTA', 'MANAGER'] : ['CASHIER', 'MANAGER'];
    if (!roles.includes(user.role) || !user.branchId || !user.employeeId)
      throw new ForbiddenException('Assigned branch staff required');
    if (
      pagerNumber !== null &&
      (!Number.isInteger(pagerNumber) || pagerNumber < 1 || pagerNumber > 999)
    )
      throw new ConflictException('Pager number must be between 1 and 999');
    await this.access.assertCanAccessBranch(user, user.branchId);
    await this.access.assertSubscriptionAllowsWrite(user.branchId);
    let result;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
        const order = await tx.order.findFirst({
          where: { id: orderId, branchId: user.branchId!, type: 'COUNTER_PICKUP' },
        });
        if (!order) throw new NotFoundException('Counter order not found in your branch');
        if (
          order.paymentStatus !== 'PAID' ||
          !['SUBMITTED', 'PREPARING', 'READY'].includes(order.status)
        )
          throw new ConflictException('Only paid open orders can use a pager');
        if (
          notify &&
          (order.status !== 'READY' || pagerNumber === null || order.pagerNumber !== pagerNumber)
        )
          throw new ConflictException('Order must be ready and still assigned to this pager');
        return tx.order.update({
          where: { id: order.id },
          data: notify
            ? { pagerNotifiedAt: order.pagerNotifiedAt ?? new Date() }
            : {
                pagerNumber,
                pagerNotifiedAt: order.pagerNumber === pagerNumber ? order.pagerNotifiedAt : null,
              },
          select: {
            id: true,
            branchId: true,
            status: true,
            callNumber: true,
            pagerNumber: true,
            pagerNotifiedAt: true,
          },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ConflictException('Pager is already assigned to another open order');
      throw error;
    }
    this.realtime.branch(result.branchId, 'order.pager.updated', result);
    return result;
  }
}
