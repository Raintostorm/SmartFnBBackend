import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  ReservationStatus,
  TableSessionStatus,
  TableStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import type {
  AllocateReservationTablesDto,
  CancelReservationDto,
  CreateReservationDto,
  ReservationListQueryDto,
  UpdateReservationDto,
} from './dto/reservation.dto.js';

const reservationInclude = {
  tables: {
    where: { releasedAt: null },
    include: { table: true },
  },
  confirmedBy: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
} satisfies Prisma.ReservationInclude;

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  async list(branchId: string, query: ReservationListQueryDto, user: AuthenticatedUser) {
    await this.branchAccess.assertCanAccessBranch(user, branchId);
    return this.prisma.reservation.findMany({
      where: {
        branchId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.from || query.to
          ? {
              reservationAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
      },
      include: reservationInclude,
      orderBy: { reservationAt: 'asc' },
    });
  }

  async get(id: string, user: AuthenticatedUser) {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id },
      include: reservationInclude,
    });
    if (!reservation) throw new NotFoundException('Reservation not found');
    await this.branchAccess.assertCanAccessBranch(user, reservation.branchId);
    return reservation;
  }

  async create(branchId: string, dto: CreateReservationDto, user: AuthenticatedUser) {
    const actor = this.employee(user);
    await this.branchAccess.assertCanManageBranch(user, branchId);
    if (actor.branchId !== branchId)
      throw new ForbiddenException('Employee is assigned to another branch');
    return this.prisma.reservation.create({
      data: {
        reservationCode: `RSV-${Date.now()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
        branchId,
        createdById: actor.employeeId,
        updatedById: actor.employeeId,
        guestName: dto.guestName,
        guestPhone: dto.guestPhone,
        guestEmail: dto.guestEmail,
        partySize: dto.partySize,
        reservationAt: new Date(dto.reservationAt),
        durationMinutes: dto.durationMinutes,
        source: dto.source,
        note: dto.note,
      },
      include: reservationInclude,
    });
  }

  async update(id: string, dto: UpdateReservationDto, user: AuthenticatedUser) {
    const current = await this.get(id, user);
    await this.branchAccess.assertCanManageBranch(user, current.branchId);
    if (!this.isEditable(current.status)) {
      throw new ConflictException('Only pending or confirmed reservations can be edited');
    }
    const actor = this.employee(user);
    return this.prisma.reservation.update({
      where: { id },
      data: {
        ...dto,
        ...(dto.reservationAt ? { reservationAt: new Date(dto.reservationAt) } : {}),
        updatedById: actor.employeeId,
      },
      include: reservationInclude,
    });
  }

  async suggestTables(id: string, user: AuthenticatedUser) {
    const reservation = await this.get(id, user);
    const tables = await this.availableTables(reservation);
    const adjacency = new Map<string, Set<string>>();
    for (const table of tables)
      adjacency.set(table.id, new Set(table.adjacentFrom.map((x) => x.adjacentTableId)));
    const candidates = new Map<string, typeof tables>();
    for (const table of tables) {
      if (table.capacity >= reservation.partySize) candidates.set(table.id, [table]);
      const queue: (typeof tables)[] = [[table]];
      while (queue.length > 0) {
        const group = queue.shift()!;
        if (group.length >= 4) continue;
        const ids = new Set(group.map((x) => x.id));
        const neighborIds = new Set(group.flatMap((x) => [...(adjacency.get(x.id) ?? [])]));
        for (const next of tables) {
          if (ids.has(next.id) || !neighborIds.has(next.id)) continue;
          const expanded = [...group, next].sort((a, b) => a.id.localeCompare(b.id));
          const key = expanded.map((x) => x.id).join(',');
          if (candidates.has(key)) continue;
          const capacity = expanded.reduce((sum, x) => sum + x.capacity, 0);
          if (capacity >= reservation.partySize) candidates.set(key, expanded);
          else queue.push(expanded);
        }
      }
    }
    return [...candidates.values()]
      .map((group) => ({
        tables: group,
        capacity: group.reduce((sum, table) => sum + table.capacity, 0),
        emptySeats: group.reduce((sum, table) => sum + table.capacity, 0) - reservation.partySize,
      }))
      .sort((a, b) => a.emptySeats - b.emptySeats || a.tables.length - b.tables.length)
      .slice(0, 3);
  }

  async allocate(id: string, dto: AllocateReservationTablesDto, user: AuthenticatedUser) {
    const current = await this.get(id, user);
    await this.branchAccess.assertCanManageBranch(user, current.branchId);
    return this.prisma.$transaction(
      async (tx) => {
        const reservation = await tx.reservation.findUniqueOrThrow({ where: { id } });
        if (!this.isEditable(reservation.status)) {
          throw new ConflictException('Reservation can no longer be allocated');
        }
        const available = await this.availableTables(reservation, tx);
        const selected = available.filter((table) => dto.tableIds.includes(table.id));
        if (selected.length !== new Set(dto.tableIds).size) {
          throw new ConflictException('One or more selected tables are no longer available');
        }
        const capacity = selected.reduce((sum, table) => sum + table.capacity, 0);
        if (capacity < reservation.partySize)
          throw new ConflictException('Selected tables do not have enough seats');
        if (!this.connected(selected))
          throw new ConflictException('Selected tables must be adjacent');
        await tx.reservationTable.deleteMany({ where: { reservationId: id } });
        await tx.reservationTable.createMany({
          data: selected.map((table) => ({ reservationId: id, tableId: table.id })),
        });
        await tx.reservation.update({
          where: { id },
          data: { tableId: selected[0]?.id, updatedById: this.employee(user).employeeId },
        });
        return tx.reservation.findUniqueOrThrow({ where: { id }, include: reservationInclude });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async confirm(id: string, user: AuthenticatedUser) {
    const actor = this.employee(user);
    const reservation = await this.get(id, user);
    await this.branchAccess.assertCanManageBranch(user, reservation.branchId);
    if (reservation.status !== ReservationStatus.PENDING)
      throw new ConflictException('Reservation is not pending');
    if (reservation.tables.length === 0)
      throw new ConflictException('Allocate tables before confirming the reservation');
    return this.prisma.reservation.update({
      where: { id },
      data: {
        status: ReservationStatus.CONFIRMED,
        confirmedAt: new Date(),
        confirmedById: actor.employeeId,
      },
      include: reservationInclude,
    });
  }

  async checkIn(id: string, user: AuthenticatedUser) {
    const actor = this.employee(user);
    return this.prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({
        where: { id },
        include: reservationInclude,
      });
      if (!reservation) throw new NotFoundException('Reservation not found');
      if (reservation.branchId !== actor.branchId)
        throw new ForbiddenException('Reservation belongs to another branch');
      if (reservation.status !== ReservationStatus.CONFIRMED)
        throw new ConflictException('Reservation is not confirmed');
      const tableIds = reservation.tables.map((entry) => entry.tableId);
      if (tableIds.length === 0) throw new ConflictException('Reservation has no allocated tables');
      const occupied = await tx.tableSessionTable.count({
        where: {
          tableId: { in: tableIds },
          releasedAt: null,
          tableSession: { status: { in: [TableSessionStatus.OPEN, TableSessionStatus.SERVING] } },
        },
      });
      if (occupied > 0) throw new ConflictException('One or more reserved tables are occupied');
      const session = await tx.tableSession.create({
        data: {
          sessionCode: `SES-${Date.now()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
          branchId: reservation.branchId,
          reservationId: reservation.id,
          openedByWaiterId: actor.employeeId,
          guestCount: reservation.partySize,
          guestName: reservation.guestName,
          guestPhone: reservation.guestPhone,
          tables: { create: tableIds.map((tableId) => ({ tableId })) },
        },
        include: { tables: { include: { table: true } } },
      });
      await tx.restaurantTable.updateMany({
        where: { id: { in: tableIds } },
        data: { status: TableStatus.OCCUPIED },
      });
      await tx.reservation.update({
        where: { id },
        data: { status: ReservationStatus.SEATED, checkedInAt: new Date() },
      });
      return session;
    });
  }

  async cancel(id: string, dto: CancelReservationDto, user: AuthenticatedUser) {
    const current = await this.get(id, user);
    await this.branchAccess.assertCanManageBranch(user, current.branchId);
    if (!this.isEditable(current.status)) {
      throw new ConflictException('Reservation can no longer be cancelled');
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.reservationTable.updateMany({
        where: { reservationId: id, releasedAt: null },
        data: { releasedAt: new Date() },
      });
      return tx.reservation.update({
        where: { id },
        data: {
          status: ReservationStatus.CANCELLED,
          cancelledAt: new Date(),
          cancellationReason: dto.reason,
        },
        include: reservationInclude,
      });
    });
  }

  async noShow(id: string, user: AuthenticatedUser) {
    const current = await this.get(id, user);
    await this.branchAccess.assertCanManageBranch(user, current.branchId);
    if (current.status !== ReservationStatus.CONFIRMED)
      throw new ConflictException('Only confirmed reservations can be marked no-show');
    return this.prisma.$transaction(async (tx) => {
      await tx.reservationTable.updateMany({
        where: { reservationId: id, releasedAt: null },
        data: { releasedAt: new Date() },
      });
      return tx.reservation.update({
        where: { id },
        data: { status: ReservationStatus.NO_SHOW, noShowAt: new Date() },
        include: reservationInclude,
      });
    });
  }

  private async availableTables(
    reservation: { id: string; branchId: string; reservationAt: Date; durationMinutes: number },
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const end = new Date(
      reservation.reservationAt.getTime() + reservation.durationMinutes * 60_000,
    );
    const tables = await client.restaurantTable.findMany({
      where: {
        branchId: reservation.branchId,
        deletedAt: null,
        isActive: true,
        status: { not: TableStatus.OUT_OF_SERVICE },
        sessionTables: {
          none: {
            releasedAt: null,
            tableSession: { status: { in: [TableSessionStatus.OPEN, TableSessionStatus.SERVING] } },
          },
        },
      },
      include: {
        adjacentFrom: true,
        adjacentTo: true,
        reservationLinks: {
          where: {
            reservationId: { not: reservation.id },
            releasedAt: null,
            reservation: {
              status: { in: [ReservationStatus.PENDING, ReservationStatus.CONFIRMED] },
              reservationAt: { lt: end },
            },
          },
          include: {
            reservation: { select: { reservationAt: true, durationMinutes: true } },
          },
        },
      },
      orderBy: [{ capacity: 'asc' }, { code: 'asc' }],
    });
    return tables
      .filter((table) =>
        table.reservationLinks.every(({ reservation: existing }) => {
          const existingEnd = new Date(
            existing.reservationAt.getTime() + existing.durationMinutes * 60_000,
          );
          return existingEnd <= reservation.reservationAt;
        }),
      )
      .map(({ reservationLinks: _reservationLinks, ...table }) => table);
  }

  private connected(
    tables: {
      id: string;
      adjacentFrom: { adjacentTableId: string }[];
      adjacentTo: { tableId: string }[];
    }[],
  ) {
    if (tables.length <= 1) return true;
    const selected = new Set(tables.map((table) => table.id));
    const visited = new Set<string>();
    const queue = [tables[0].id];
    const byId = new Map(tables.map((table) => [table.id, table]));
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const table = byId.get(id);
      for (const neighbor of table?.adjacentFrom ?? []) {
        if (selected.has(neighbor.adjacentTableId)) queue.push(neighbor.adjacentTableId);
      }
      for (const neighbor of table?.adjacentTo ?? []) {
        if (selected.has(neighbor.tableId)) queue.push(neighbor.tableId);
      }
    }
    return visited.size === tables.length;
  }

  private employee(user: AuthenticatedUser) {
    if (!user.employeeId || !user.branchId)
      throw new ForbiddenException('An assigned employee profile is required');
    return { employeeId: user.employeeId, branchId: user.branchId };
  }

  private isEditable(status: ReservationStatus) {
    return status === ReservationStatus.PENDING || status === ReservationStatus.CONFIRMED;
  }
}
