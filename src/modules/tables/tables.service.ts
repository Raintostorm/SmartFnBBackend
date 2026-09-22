import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TableStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import type { CreateTableDto, ReplaceTableAdjacencyDto, UpdateTableDto } from './dto/table.dto.js';

const tableSelect = {
  id: true,
  branchId: true,
  code: true,
  name: true,
  area: true,
  floor: true,
  capacity: true,
  positionX: true,
  positionY: true,
  width: true,
  height: true,
  status: true,
  isActive: true,
  adjacentFrom: { select: { adjacentTableId: true } },
  adjacentTo: { select: { tableId: true } },
} satisfies Prisma.RestaurantTableSelect;

@Injectable()
export class TablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  async list(branchId: string, user: AuthenticatedUser) {
    await this.branchAccess.assertCanAccessBranch(user, branchId);
    const tables = await this.prisma.restaurantTable.findMany({
      where: { branchId, deletedAt: null },
      select: tableSelect,
      orderBy: [{ floor: 'asc' }, { code: 'asc' }],
    });
    return tables.map((table) => this.toResponse(table));
  }

  async create(branchId: string, dto: CreateTableDto, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageBranch(user, branchId);
    try {
      const table = await this.prisma.restaurantTable.create({
        data: { ...dto, branchId },
        select: tableSelect,
      });
      return this.toResponse(table);
    } catch (error) {
      this.rethrowUnique(error);
    }
  }

  async update(tableId: string, dto: UpdateTableDto, user: AuthenticatedUser) {
    const current = await this.getTable(tableId);
    await this.branchAccess.assertCanManageBranch(user, current.branchId);
    try {
      const table = await this.prisma.restaurantTable.update({
        where: { id: tableId },
        data: dto,
        select: tableSelect,
      });
      return this.toResponse(table);
    } catch (error) {
      this.rethrowUnique(error);
    }
  }

  async updateStatus(tableId: string, status: TableStatus, user: AuthenticatedUser) {
    const current = await this.getTable(tableId);
    await this.branchAccess.assertCanManageBranch(user, current.branchId);
    if (status === TableStatus.AVAILABLE) {
      const activeSession = await this.prisma.tableSessionTable.count({
        where: { tableId, releasedAt: null, tableSession: { status: { in: ['OPEN', 'SERVING'] } } },
      });
      if (activeSession > 0) throw new ConflictException('Table belongs to an open session');
    }
    const table = await this.prisma.restaurantTable.update({
      where: { id: tableId },
      data: { status, isActive: status !== TableStatus.OUT_OF_SERVICE },
      select: tableSelect,
    });
    return this.toResponse(table);
  }

  async replaceAdjacency(
    branchId: string,
    tableId: string,
    dto: ReplaceTableAdjacencyDto,
    user: AuthenticatedUser,
  ) {
    await this.branchAccess.assertCanManageBranch(user, branchId);
    if (dto.adjacentTableIds.includes(tableId)) {
      throw new ConflictException('A table cannot be adjacent to itself');
    }
    const ids = [tableId, ...dto.adjacentTableIds];
    const count = await this.prisma.restaurantTable.count({
      where: { id: { in: ids }, branchId, deletedAt: null },
    });
    if (count !== ids.length) throw new NotFoundException('One or more tables were not found');

    await this.prisma.$transaction(async (tx) => {
      await tx.tableAdjacency.deleteMany({
        where: { branchId, OR: [{ tableId }, { adjacentTableId: tableId }] },
      });
      if (dto.adjacentTableIds.length > 0) {
        await tx.tableAdjacency.createMany({
          data: dto.adjacentTableIds.flatMap((adjacentTableId) => [
            { branchId, tableId, adjacentTableId },
            { branchId, tableId: adjacentTableId, adjacentTableId: tableId },
          ]),
          skipDuplicates: true,
        });
      }
    });
    return this.list(branchId, user);
  }

  private async getTable(id: string) {
    const table = await this.prisma.restaurantTable.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, branchId: true },
    });
    if (!table) throw new NotFoundException('Table not found');
    return table;
  }

  private toResponse<
    T extends { adjacentFrom: { adjacentTableId: string }[]; adjacentTo: { tableId: string }[] },
  >(table: T) {
    const { adjacentFrom, adjacentTo, ...rest } = table;
    return {
      ...rest,
      adjacentTableIds: [
        ...new Set([
          ...adjacentFrom.map((x) => x.adjacentTableId),
          ...adjacentTo.map((x) => x.tableId),
        ]),
      ],
    };
  }

  private rethrowUnique(error: unknown): never {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      throw new ConflictException('Table code already exists in this branch');
    }
    throw error;
  }
}
