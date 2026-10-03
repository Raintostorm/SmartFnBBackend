import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { AppRole } from '../auth/app-role.enum.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';

export function managerActor(user: AuthenticatedUser) {
  if (user.role !== AppRole.MANAGER || !user.branchId || !user.employeeId) {
    throw new ForbiddenException('An assigned Branch Manager is required');
  }
  return { branchId: user.branchId, employeeId: user.employeeId, userId: user.id };
}

/** Only allowlisted snapshots reach this append-only application log; never passwords or tokens. */
export function writeBranchAudit(
  tx: Prisma.TransactionClient,
  user: AuthenticatedUser,
  event: {
    action: string;
    entityType: string;
    entityId: string;
    reason?: string;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
  },
) {
  if (!user.branchId || !user.employeeId) throw new ForbiddenException('Branch employee required');
  return tx.branchAuditLog.create({
    data: {
      branchId: user.branchId,
      actorUserId: user.id,
      actorEmployeeId: user.employeeId,
      actorRole: user.role,
      ...event,
    },
  });
}
