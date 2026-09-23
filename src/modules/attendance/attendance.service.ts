import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EmployeeStatus, WorkSessionStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import type {
  AssignShiftDto,
  CheckInDto,
  CheckOutDto,
  CreateShiftTemplateDto,
  ShiftRangeQueryDto,
  UpdateShiftTemplateDto,
} from './dto/attendance.dto.js';

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  async listTemplates(branchId: string, user: AuthenticatedUser) {
    await this.branchAccess.assertCanAccessBranch(user, branchId);
    return this.prisma.shiftTemplate.findMany({
      where: { branchId },
      orderBy: [{ isActive: 'desc' }, { startTime: 'asc' }],
    });
  }

  async createTemplate(branchId: string, dto: CreateShiftTemplateDto, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageBranch(user, branchId);
    this.assertTimeRange(dto.startTime, dto.endTime);
    return this.prisma.shiftTemplate.create({ data: { branchId, ...dto } });
  }

  async updateTemplate(
    branchId: string,
    templateId: string,
    dto: UpdateShiftTemplateDto,
    user: AuthenticatedUser,
  ) {
    await this.branchAccess.assertCanManageBranch(user, branchId);
    const current = await this.prisma.shiftTemplate.findFirst({
      where: { id: templateId, branchId },
    });
    if (!current) throw new NotFoundException('Shift template not found');
    this.assertTimeRange(dto.startTime ?? current.startTime, dto.endTime ?? current.endTime);
    return this.prisma.shiftTemplate.update({ where: { id: templateId }, data: dto });
  }

  async listAssignments(branchId: string, query: ShiftRangeQueryDto, user: AuthenticatedUser) {
    await this.branchAccess.assertCanAccessBranch(user, branchId);
    return this.prisma.shiftAssignment.findMany({
      where: {
        branchId,
        ...(query.from || query.to
          ? {
              workDate: {
                ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
                ...(query.to ? { lte: new Date(`${query.to}T00:00:00.000Z`) } : {}),
              },
            }
          : {}),
      },
      include: {
        employee: {
          select: { id: true, employeeCode: true, firstName: true, lastName: true, status: true },
        },
        shiftTemplate: true,
      },
      orderBy: [{ workDate: 'asc' }, { scheduledStart: 'asc' }],
    });
  }

  async assign(branchId: string, dto: AssignShiftDto, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageBranch(user, branchId);
    const [branch, employee, template] = await Promise.all([
      this.prisma.branch.findUnique({ where: { id: branchId }, select: { timezone: true } }),
      this.prisma.employee.findFirst({
        where: { id: dto.employeeId, branchId, deletedAt: null, status: EmployeeStatus.ACTIVE },
      }),
      this.prisma.shiftTemplate.findFirst({
        where: { id: dto.shiftTemplateId, branchId, isActive: true },
      }),
    ]);
    if (!branch) throw new NotFoundException('Branch not found');
    if (!employee) throw new NotFoundException('Active employee not found in this branch');
    if (!template) throw new NotFoundException('Active shift template not found in this branch');
    const scheduledStart = this.zonedDateTime(dto.workDate, template.startTime, branch.timezone);
    const scheduledEnd = this.zonedDateTime(dto.workDate, template.endTime, branch.timezone);
    return this.prisma.shiftAssignment.upsert({
      where: {
        employeeId_workDate: {
          employeeId: dto.employeeId,
          workDate: new Date(`${dto.workDate}T00:00:00.000Z`),
        },
      },
      create: {
        branchId,
        employeeId: dto.employeeId,
        shiftTemplateId: dto.shiftTemplateId,
        workDate: new Date(`${dto.workDate}T00:00:00.000Z`),
        scheduledStart,
        scheduledEnd,
      },
      update: {
        shiftTemplateId: dto.shiftTemplateId,
        scheduledStart,
        scheduledEnd,
        status: 'SCHEDULED',
      },
      include: { employee: true, shiftTemplate: true },
    });
  }

  async unassign(branchId: string, assignmentId: string, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageBranch(user, branchId);
    const assignment = await this.prisma.shiftAssignment.findFirst({
      where: { id: assignmentId, branchId },
    });
    if (!assignment) throw new NotFoundException('Shift assignment not found');
    const sessions = await this.prisma.workSession.count({
      where: { shiftAssignmentId: assignmentId },
    });
    if (sessions > 0)
      throw new ConflictException('A work session already exists for this assignment');
    await this.prisma.shiftAssignment.delete({ where: { id: assignmentId } });
    return { id: assignmentId, deleted: true };
  }

  async listWorkSessions(branchId: string, query: ShiftRangeQueryDto, user: AuthenticatedUser) {
    await this.branchAccess.assertCanAccessBranch(user, branchId);
    return this.prisma.workSession.findMany({
      where: {
        branchId,
        ...(query.from || query.to
          ? {
              checkedInAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
      },
      include: { employee: true, shiftAssignment: { include: { shiftTemplate: true } } },
      orderBy: { checkedInAt: 'desc' },
    });
  }

  async checkIn(branchId: string, dto: CheckInDto, user: AuthenticatedUser) {
    await this.branchAccess.assertCanManageBranch(user, branchId);
    return this.prisma.$transaction(async (tx) => {
      const employee = await tx.employee.findFirst({
        where: { id: dto.employeeId, branchId, deletedAt: null, status: EmployeeStatus.ACTIVE },
      });
      if (!employee) throw new NotFoundException('Active employee not found in this branch');
      const open = await tx.workSession.findFirst({
        where: { employeeId: dto.employeeId, status: WorkSessionStatus.ACTIVE },
      });
      if (open) throw new ConflictException('Employee already has an active work session');
      const assignment = dto.shiftAssignmentId
        ? await tx.shiftAssignment.findFirst({
            where: {
              id: dto.shiftAssignmentId,
              employeeId: dto.employeeId,
              branchId,
              status: 'SCHEDULED',
            },
          })
        : null;
      if (dto.shiftAssignmentId && !assignment) {
        throw new NotFoundException('Scheduled shift assignment not found');
      }
      return tx.workSession.create({
        data: {
          employeeId: dto.employeeId,
          branchId,
          status: WorkSessionStatus.ACTIVE,
          shiftAssignmentId: assignment?.id,
          scheduledStart: assignment?.scheduledStart,
          scheduledEnd: assignment?.scheduledEnd,
          checkedInAt: new Date(),
          isUnscheduled: !assignment,
        },
        include: { employee: true, shiftAssignment: { include: { shiftTemplate: true } } },
      });
    });
  }

  async checkOut(
    branchId: string,
    workSessionId: string,
    dto: CheckOutDto,
    user: AuthenticatedUser,
  ) {
    await this.branchAccess.assertCanManageBranch(user, branchId);
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.workSession.findFirst({
        where: { id: workSessionId, branchId, status: WorkSessionStatus.ACTIVE },
      });
      if (!session) throw new NotFoundException('Active work session not found');
      const pendingTasks = await tx.servingTask.count({
        where: { claimedByWaiterId: session.employeeId, status: 'CLAIMED' },
      });
      if (pendingTasks > 0 && !dto.force) {
        throw new ConflictException({
          message: 'Employee still owns serving tasks',
          pendingTaskCount: pendingTasks,
        });
      }
      if (pendingTasks > 0) {
        await tx.servingTask.updateMany({
          where: { claimedByWaiterId: session.employeeId, status: 'CLAIMED' },
          data: { status: 'WAITING', claimedByWaiterId: null, claimedAt: null },
        });
      }
      const checkedOutAt = new Date();
      const updated = await tx.workSession.update({
        where: { id: workSessionId },
        data: { status: WorkSessionStatus.COMPLETED, checkedOutAt, note: dto.note },
        include: { employee: true, shiftAssignment: { include: { shiftTemplate: true } } },
      });
      if (session.shiftAssignmentId) {
        await tx.shiftAssignment.update({
          where: { id: session.shiftAssignmentId },
          data: { status: 'COMPLETED' },
        });
      }
      return updated;
    });
  }

  private assertTimeRange(startTime: string, endTime: string) {
    if (startTime >= endTime) {
      throw new BadRequestException('Shift end time must be after start time on the same day');
    }
  }

  private zonedDateTime(date: string, time: string, timeZone: string): Date {
    const desired = Date.parse(`${date}T${time}:00.000Z`);
    let candidate = new Date(desired);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(candidate);
      const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      const represented = Date.parse(
        `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}:00.000Z`,
      );
      candidate = new Date(candidate.getTime() + desired - represented);
    }
    if (Number.isNaN(candidate.getTime()))
      throw new BadRequestException('Invalid shift date or timezone');
    return candidate;
  }
}
