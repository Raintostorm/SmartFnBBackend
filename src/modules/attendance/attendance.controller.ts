import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AttendanceService } from './attendance.service.js';
import {
  AssignShiftDto,
  CheckInDto,
  CheckOutDto,
  CreateShiftTemplateDto,
  ShiftRangeQueryDto,
  UpdateShiftTemplateDto,
} from './dto/attendance.dto.js';
import { RealtimePublisher } from '../../realtime/realtime.publisher.js';

@ApiTags('Shifts and work sessions')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@Controller('branches/:branchId')
export class AttendanceController {
  constructor(
    private readonly service: AttendanceService,
    private readonly realtime: RealtimePublisher,
  ) {}

  @Roles(AppRole.OWNER, AppRole.MANAGER)
  @Get('shift-templates')
  listTemplates(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.listTemplates(branchId, user);
  }

  @Roles(AppRole.MANAGER)
  @Post('shift-templates')
  async createTemplate(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Body() dto: CreateShiftTemplateDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.service.createTemplate(branchId, dto, user);
    this.realtime.branch(branchId, 'shift-template.created', { id: result.id });
    return result;
  }

  @Roles(AppRole.MANAGER)
  @Patch('shift-templates/:templateId')
  async updateTemplate(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Param('templateId', new ParseUUIDPipe()) templateId: string,
    @Body() dto: UpdateShiftTemplateDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.service.updateTemplate(branchId, templateId, dto, user);
    this.realtime.branch(branchId, 'shift-template.updated', { id: result.id });
    return result;
  }

  @Roles(AppRole.OWNER, AppRole.MANAGER)
  @Get('shift-assignments')
  listAssignments(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Query() query: ShiftRangeQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.listAssignments(branchId, query, user);
  }

  @Roles(AppRole.MANAGER)
  @Post('shift-assignments')
  @ApiOperation({ summary: 'Assign or replace one employee shift for a date' })
  async assign(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Body() dto: AssignShiftDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.service.assign(branchId, dto, user);
    this.realtime.branch(branchId, 'shift-assignment.updated', { id: result.id });
    return result;
  }

  @Roles(AppRole.MANAGER)
  @Delete('shift-assignments/:assignmentId')
  async unassign(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.service.unassign(branchId, assignmentId, user);
    this.realtime.branch(branchId, 'shift-assignment.cancelled', { id: result.id });
    return result;
  }

  @Roles(AppRole.OWNER, AppRole.MANAGER)
  @Get('work-sessions')
  listWorkSessions(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Query() query: ShiftRangeQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.listWorkSessions(branchId, query, user);
  }

  @Roles(AppRole.MANAGER)
  @Post('work-sessions/check-in')
  async checkIn(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Body() dto: CheckInDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.service.checkIn(branchId, dto, user);
    this.realtime.branch(branchId, 'work-session.checked-in', { id: result.id });
    return result;
  }

  @Roles(AppRole.MANAGER)
  @Post('work-sessions/:workSessionId/check-out')
  async checkOut(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Param('workSessionId', new ParseUUIDPipe()) workSessionId: string,
    @Body() dto: CheckOutDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.service.checkOut(branchId, workSessionId, dto, user);
    this.realtime.branch(branchId, 'work-session.checked-out', { id: result.id });
    return result;
  }
}
