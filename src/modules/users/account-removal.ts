import { ConflictException, ForbiddenException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { EmployeeStatus, Prisma, UserStatus } from '../../generated/prisma/client.js';

/**
 * Removing an account a superior no longer needs, in two modes (proposal agreed with the team):
 *  - DELETE: the account never set a password, never signed in and never acted on any data → the row is deleted
 *    and the email can be invited again.
 *  - ANONYMIZE: the account has a footprint (orders, payments, attendance, audit…) → the row stays so history keeps
 *    pointing at it, but personal data is wiped, sign-in is disabled for good and the email is released.
 * Ledger, audit and order rows are never edited (append-only, BR-93).
 */
export type RemovalMode = 'DELETE' | 'ANONYMIZE';

type Ref = { model: string; field: string };

/**
 * Every column that records this account (or its employee profile) as the ACTOR of something.
 * Rows OWNED by the account (sessions, setup links, its own reset requests, the employee/owner profile)
 * are not listed: they go with it. `test/account-removal.test.mjs` parses `schema.prisma` and fails when a
 * new relation to User/Employee is missing here.
 */
export const USER_ACTOR_REFERENCES: readonly Ref[] = [
  { model: 'ownerChainAssignment', field: 'assignedById' },
  { model: 'registrationApplication', field: 'reviewedById' },
  { model: 'platformSupportAction', field: 'actorUserId' },
  { model: 'businessSubscriptionEvent', field: 'changedById' },
  { model: 'passwordResetRequest', field: 'handledById' },
  { model: 'passwordResetAudit', field: 'actorUserId' },
  { model: 'payosChannelAuditLog', field: 'actorUserId' },
  { model: 'menuImport', field: 'createdById' },
  { model: 'refund', field: 'requestedByUserId' },
  { model: 'refund', field: 'completedByUserId' },
  { model: 'refundApprovalRequest', field: 'requestedByUserId' },
  { model: 'refundApprovalRequest', field: 'reviewedByUserId' },
  { model: 'refundApprovalRequest', field: 'completedByUserId' },
  { model: 'chainAuditLog', field: 'actorUserId' },
  { model: 'branchAuditLog', field: 'actorUserId' },
  { model: 'refundPrintLog', field: 'printedByUserId' },
];

export const EMPLOYEE_ACTOR_REFERENCES: readonly Ref[] = [
  { model: 'tableSession', field: 'openedByWaiterId' },
  { model: 'tableSession', field: 'closedByWaiterId' },
  { model: 'reservation', field: 'confirmedById' },
  { model: 'reservation', field: 'createdById' },
  { model: 'reservation', field: 'updatedById' },
  { model: 'branchMenuOption', field: 'updatedById' },
  { model: 'branchMenuItem', field: 'updatedById' },
  { model: 'order', field: 'waiterId' },
  { model: 'order', field: 'createdByWaiterId' },
  { model: 'order', field: 'createdByCashierId' },
  { model: 'order', field: 'deliveredById' },
  { model: 'order', field: 'cancelledById' },
  { model: 'orderItem', field: 'servedByWaiterId' },
  { model: 'orderItem', field: 'unavailableById' },
  { model: 'orderItem', field: 'startedByKitchenId' },
  { model: 'orderItem', field: 'completedByKitchenId' },
  { model: 'orderItem', field: 'cancelledById' },
  { model: 'orderItemUnit', field: 'startedById' },
  { model: 'orderItemUnit', field: 'completedById' },
  { model: 'payment', field: 'processedById' },
  { model: 'invoice', field: 'issuedById' },
  { model: 'invoice', field: 'cancelledById' },
  { model: 'printJob', field: 'printedById' },
  { model: 'displayDevice', field: 'pairedById' },
  { model: 'attendance', field: 'employeeId' },
  { model: 'workSession', field: 'employeeId' },
  { model: 'shiftAssignment', field: 'employeeId' },
  { model: 'servingTask', field: 'claimedByWaiterId' },
  { model: 'servingTask', field: 'servedByWaiterId' },
  { model: 'refund', field: 'requestedByEmployeeId' },
  { model: 'refund', field: 'completedByEmployeeId' },
  { model: 'refundApprovalRequest', field: 'requestedByEmployeeId' },
  { model: 'refundApprovalRequest', field: 'reviewedByEmployeeId' },
  { model: 'refundApprovalRequest', field: 'completedByEmployeeId' },
  { model: 'branchAuditLog', field: 'actorEmployeeId' },
  { model: 'refundPrintLog', field: 'printedByEmployeeId' },
];

// `count` with `take: 1` stops at the first match and works on every table, including composite-key ones
// (branchMenuItem, branchMenuOption have no `id` column, so `select: { id: true }` would be rejected).
type Delegate = { count(args: { where: Record<string, string>; take: number }): Promise<number> };
type Client = Prisma.TransactionClient;

export interface RemovableAccount {
  userId: string;
  employeeId: string | null;
  status: UserStatus;
  staffInvitationState: string | null;
  emailVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  lastPasswordChangedAt: Date | null;
}

/**
 * Tables (model.field) where this account acted. Empty = no footprint.
 * Runs the ~50 checks in parallel on the given client. Call it with the pooled client OUTSIDE an interactive
 * transaction: run one by one inside a transaction they exceed Prisma's 5 s transaction timeout on a remote DB.
 * Safe because only locked accounts / cancelled invitations are removed, so no new rows can appear meanwhile.
 */
export async function accountFootprint(client: Client, account: Pick<RemovableAccount, 'userId' | 'employeeId'>): Promise<string[]> {
  const checks = [
    ...USER_ACTOR_REFERENCES.map((ref) => ({ ref, id: account.userId })),
    ...(account.employeeId ? EMPLOYEE_ACTOR_REFERENCES.map((ref) => ({ ref, id: account.employeeId! })) : []),
  ];
  const hits = await Promise.all(
    checks.map(async ({ ref, id }) => {
      const delegate = (client as unknown as Record<string, Delegate>)[ref.model];
      return (await delegate.count({ where: { [ref.field]: id }, take: 1 })) > 0 ? `${ref.model}.${ref.field}` : null;
    }),
  );
  return hits.filter((hit): hit is string => hit !== null);
}

/** Only accounts already out of use may be removed: locked, or an invitation that was cancelled. */
export function assertRemovable(account: RemovableAccount, actorUserId: string) {
  if (account.userId === actorUserId) throw new ForbiddenException('You cannot remove your own account');
  if (account.status !== UserStatus.SUSPENDED && account.staffInvitationState !== 'CANCELLED')
    throw new ConflictException('Lock the account or cancel the invitation before removing it');
}

/** DELETE only when the account was never activated and has no footprint. */
export function decideMode(account: RemovableAccount, footprint: string[]): RemovalMode {
  const activated = !!(account.emailVerifiedAt || account.lastLoginAt || account.lastPasswordChangedAt);
  return !activated && footprint.length === 0 ? 'DELETE' : 'ANONYMIZE';
}

export async function removalMode(client: Client, account: RemovableAccount): Promise<{ mode: RemovalMode; footprint: string[] }> {
  const footprint = await accountFootprint(client, account);
  return { mode: decideMode(account, footprint), footprint };
}

/** `an.nguyen@gmail.com` → `a***@gmail.com`: enough to recognise in the audit log, not to contact. */
export function maskEmail(email: string) {
  const [local, domain] = email.split('@');
  return domain ? `${local.slice(0, 1)}***@${domain}` : '***';
}

export const anonymizedEmail = (userId: string) => `deleted+${userId}@deleted.invalid`;

/** Applies the mode inside the caller's transaction (the caller writes its own audit row in the same tx). */
export async function applyRemoval(tx: Client, account: RemovableAccount, mode: RemovalMode, now = new Date()) {
  if (mode === 'DELETE') {
    // Cascades: employee profile, sessions, setup links, its own reset requests.
    await tx.user.delete({ where: { id: account.userId } });
    return;
  }
  await tx.passwordSetupToken.updateMany({ where: { userId: account.userId, usedAt: null, cancelledAt: null }, data: { cancelledAt: now } });
  await tx.authSession.updateMany({ where: { userId: account.userId, revokedAt: null }, data: { revokedAt: now } });
  await tx.passwordResetRequest.updateMany({ where: { userId: account.userId, status: 'PENDING' }, data: { status: 'EXPIRED', handledAt: now } });
  await tx.user.update({
    where: { id: account.userId },
    data: {
      email: anonymizedEmail(account.userId),
      phone: null,
      passwordHash: `!removed:${randomBytes(16).toString('hex')}`,
      status: UserStatus.SUSPENDED,
      staffInvitationState: 'CANCELLED',
      emailSendStatus: null,
      emailSentAt: null,
      deletedAt: now,
    },
  });
  if (account.employeeId)
    await tx.employee.update({
      where: { id: account.employeeId },
      data: { firstName: 'Tài khoản', lastName: 'đã xoá', dateOfBirth: null, jobTitle: null, status: EmployeeStatus.TERMINATED, deletedAt: now },
    });
}
