import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import {
  AllocateReservationTablesDto,
  CancelReservationDto,
  CreateReservationDto,
  ReservationListQueryDto,
  UpdateReservationDto,
} from './dto/reservation.dto.js';
import { ReservationsService } from './reservations.service.js';
import { RealtimePublisher } from '../../realtime/realtime.publisher.js';

@ApiTags('Reservations and table allocation')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@Controller()
export class ReservationsController {
  constructor(
    private readonly service: ReservationsService,
    private readonly realtime: RealtimePublisher,
  ) {}

  @Roles(AppRole.MANAGER, AppRole.WAITER)
  @Get('branches/:branchId/reservations')
  list(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Query() query: ReservationListQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.list(branchId, query, user);
  }

  @Roles(AppRole.MANAGER, AppRole.WAITER)
  @Get('reservations/:id')
  get(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.get(id, user);
  }

  @Roles(AppRole.MANAGER)
  @Post('branches/:branchId/reservations')
  async create(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Body() dto: CreateReservationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.service.create(branchId, dto, user);
    this.realtime.branch(branchId, 'reservation.created', { id: result.id, status: result.status });
    return result;
  }

  @Roles(AppRole.MANAGER)
  @Patch('reservations/:id')
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateReservationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.service.update(id, dto, user);
    this.realtime.branch(result.branchId, 'reservation.updated', {
      id: result.id,
      status: result.status,
    });
    return result;
  }

  @Roles(AppRole.MANAGER)
  @Get('reservations/:id/table-suggestions')
  @ApiOperation({ summary: 'Return the three best single or adjacent-table options' })
  suggest(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.suggestTables(id, user);
  }

  @Roles(AppRole.MANAGER)
  @Post('reservations/:id/tables')
  async allocate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AllocateReservationTablesDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.service.allocate(id, dto, user);
    this.realtime.branch(result.branchId, 'reservation.tables-allocated', { id: result.id });
    return result;
  }

  @Roles(AppRole.MANAGER)
  @Post('reservations/:id/confirm')
  async confirm(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.service.confirm(id, user);
    this.realtime.branch(result.branchId, 'reservation.confirmed', { id: result.id });
    return result;
  }

  @Roles(AppRole.WAITER)
  @Post('reservations/:id/check-in')
  async checkIn(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.service.checkIn(id, user);
    this.realtime.branch(result.branchId, 'reservation.checked-in', { id, sessionId: result.id });
    return result;
  }

  @Roles(AppRole.MANAGER)
  @Post('reservations/:id/cancel')
  async cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CancelReservationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.service.cancel(id, dto, user);
    this.realtime.branch(result.branchId, 'reservation.cancelled', { id: result.id });
    return result;
  }

  @Roles(AppRole.MANAGER)
  @Post('reservations/:id/no-show')
  async noShow(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.service.noShow(id, user);
    this.realtime.branch(result.branchId, 'reservation.no-show', { id: result.id });
    return result;
  }
}
