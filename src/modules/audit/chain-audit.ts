import type { Prisma } from '../../generated/prisma/client.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';

type AuditClient = Pick<Prisma.TransactionClient, 'chainAuditLog'>;

export interface ChainAuditEvent {
  action: string;
  entityType: string;
  entityId?: string | null;
  reason?: string;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
}

/**
 * BR-06 audit for chain-wide configuration (combos, chain prices, options, toppings,
 * branding, posters). Call inside the same transaction as the change. Callers pass
 * allowlisted snapshots only — never passwords, tokens or keys.
 */
export function writeChainAudit(tx: AuditClient, user: Pick<AuthenticatedUser, 'id' | 'role'>, chainId: string, event: ChainAuditEvent) {
  return tx.chainAuditLog.create({
    data: {
      chainId,
      actorUserId: user.id,
      actorRole: user.role,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId ?? null,
      reason: event.reason?.slice(0, 500),
      before: (event.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (event.after ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

/** Keeps only the listed keys and turns Decimal/Date values into strings for a JSON snapshot. */
export function auditSnapshot<T extends object>(value: T | null | undefined, keys: readonly (keyof T)[]): Prisma.InputJsonValue | null {
  if (!value) return null;
  const out: Record<string, Prisma.InputJsonValue | null> = {};
  for (const key of keys) {
    const v = (value as Record<string, unknown>)[key as string];
    out[key as string] = v === undefined || v === null ? null
      : v instanceof Date ? v.toISOString()
      : typeof v === 'object' && !Array.isArray(v) ? String(v)
      : (v as Prisma.InputJsonValue);
  }
  return out;
}

/** Combo snapshot including components/choices, prices as strings. */
export function comboSnapshot(combo: { name: string; price: unknown; isActive: boolean; categoryId: string; components?: { type: string; name: string; quantity: number; fixedSizeCode: string | null; choices: { menuItemId: string; surcharge: unknown; isDefault: boolean }[] }[] } | null | undefined): Prisma.InputJsonValue | null {
  if (!combo) return null;
  return {
    name: combo.name,
    price: String(combo.price),
    isActive: combo.isActive,
    categoryId: combo.categoryId,
    components: (combo.components ?? []).map((c) => ({
      type: c.type, name: c.name, quantity: c.quantity, fixedSizeCode: c.fixedSizeCode,
      choices: c.choices.map((x) => ({ menuItemId: x.menuItemId, surcharge: String(x.surcharge), isDefault: x.isDefault })),
    })),
  };
}
