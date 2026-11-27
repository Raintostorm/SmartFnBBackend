import type { Prisma } from '../../generated/prisma/client.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { writeChainAudit } from '../audit/chain-audit.js';

export interface WholeMenuResult {
  branchId: string;
  /** Menu items / combos of the chain now sold at the branch (all non-deleted ones). */
  items: number;
  combos: number;
  /** How many of them were not sold there before this call. */
  addedItems: number;
  addedCombos: number;
}

/**
 * Sells every menu item and combo of the chain at one branch (e.g. a branch just opened), instead of ticking the
 * branch on each item. Existing rows are switched back on and keep their branch price; missing rows are created
 * with the chain price. Daily "còn bán" stays with the Store Manager. Runs inside the caller's transaction and
 * writes one chain audit row (BR-06).
 */
export async function assignWholeMenuToBranch(
  tx: Prisma.TransactionClient,
  user: Pick<AuthenticatedUser, 'id' | 'role'>,
  chainId: string,
  branchId: string,
): Promise<WholeMenuResult> {
  const [items, combos] = await Promise.all([
    tx.menuItem.findMany({
      where: { deletedAt: null, category: { chainId, deletedAt: null } },
      select: { id: true },
    }),
    tx.combo.findMany({ where: { chainId, deletedAt: null }, select: { id: true } }),
  ]);
  const itemIds = items.map(({ id }) => id);
  const comboIds = combos.map(({ id }) => id);

  const [enabledItems, enabledCombos] = await Promise.all([
    itemIds.length
      ? tx.branchMenuItem.findMany({ where: { branchId, menuItemId: { in: itemIds }, isEnabled: true }, select: { menuItemId: true } })
      : [],
    comboIds.length
      ? tx.branchCombo.findMany({ where: { branchId, comboId: { in: comboIds }, isEnabled: true }, select: { comboId: true } })
      : [],
  ]);

  if (itemIds.length) {
    await tx.branchMenuItem.updateMany({
      where: { branchId, menuItemId: { in: itemIds }, isEnabled: false },
      data: { isEnabled: true },
    });
    await tx.branchMenuItem.createMany({
      data: itemIds.map((menuItemId) => ({ branchId, menuItemId })),
      skipDuplicates: true,
    });
  }
  if (comboIds.length) {
    await tx.branchCombo.updateMany({
      where: { branchId, comboId: { in: comboIds }, isEnabled: false },
      data: { isEnabled: true },
    });
    await tx.branchCombo.createMany({
      data: comboIds.map((comboId) => ({ branchId, comboId })),
      skipDuplicates: true,
    });
  }

  const result: WholeMenuResult = {
    branchId,
    items: itemIds.length,
    combos: comboIds.length,
    addedItems: itemIds.length - enabledItems.length,
    addedCombos: comboIds.length - enabledCombos.length,
  };
  await writeChainAudit(tx, user, chainId, {
    action: 'BRANCH_WHOLE_MENU_ASSIGNED',
    entityType: 'Branch',
    entityId: branchId,
    after: { ...result },
  });
  return result;
}
