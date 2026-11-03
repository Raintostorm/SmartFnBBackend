import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';

export async function priceExtras(
  tx: Prisma.TransactionClient,
  branchId: string,
  menuItemId: string,
  selected: { extraId: string; quantity: number }[] = [],
) {
  if (
    !Array.isArray(selected) ||
    selected.length > 100 ||
    new Set(selected.map((x) => x.extraId)).size !== selected.length ||
    selected.some((x) => !Number.isInteger(x.quantity) || x.quantity < 1 || x.quantity > 5)
  ) {
    throw new BadRequestException('Extras must be unique with quantities between 1 and 5');
  }
  if (!selected.length) return { total: new Prisma.Decimal(0), snapshots: [] };
  const item = await tx.menuItem.findFirst({
    where: {
      id: menuItemId,
      deletedAt: null,
      category: { chain: { branches: { some: { id: branchId, deletedAt: null } } } },
    },
    select: {
      maxExtras: true,
      category: { select: { chainId: true } },
      extras: {
        where: { extraId: { in: selected.map((x) => x.extraId) } },
        include: { extra: { include: { branches: { where: { branchId } } } } },
      },
    },
  });
  if (!item || selected.reduce((n, x) => n + x.quantity, 0) > item.maxExtras) {
    throw new BadRequestException('The total extra quantity exceeds this item limit');
  }
  const snapshots = selected.map((selection) => {
    const link = item.extras.find((x) => x.extraId === selection.extraId);
    if (!link || link.extra.chainId !== item.category.chainId)
      throw new BadRequestException('Extra does not belong to this item');
    if (!link.extra.isActive || link.extra.branches.some((x) => !x.isAvailable))
      throw new ConflictException('An extra is sold out');
    if (selection.quantity > link.maxQuantity)
      throw new BadRequestException('Extra quantity exceeds this item limit');
    return {
      id: link.extraId,
      kind: 'EXTRA',
      groupCode: 'EXTRA',
      groupName: 'Topping',
      name: link.extra.name,
      quantity: selection.quantity,
      unitPrice: link.price.toString(),
      priceDelta: link.price.mul(selection.quantity).toString(),
    };
  });
  return {
    snapshots,
    total: snapshots.reduce((sum, x) => sum.add(x.priceDelta), new Prisma.Decimal(0)),
  };
}
