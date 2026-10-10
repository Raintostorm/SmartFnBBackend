import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  HttpCode,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RealtimePublisher } from '../../realtime/realtime.publisher.js';
import { ManagerStaffService } from './manager-staff.service.js';
import { ManagerOperationsService } from './manager-operations.service.js';
import { ManagerReportsService } from './manager-reports.service.js';
import {
  ManagerAuditQueryDto,
  ManagerAvailabilityDto,
  ManagerCreateStaffDto,
  ManagerOrderQueryDto,
  ManagerReportQueryDto,
  ManagerResetPasswordDto,
  ManagerStaffQueryDto,
  ManagerStaffStatusDto,
  ManagerUpdateStaffDto,
} from './manager.dto.js';
import { ApiAuthenticatedOperation } from '../../common/swagger/swagger.decorators.js';

@Roles(AppRole.MANAGER)
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiAuthenticatedOperation()
@ApiTags('Branch Manager')
@Controller('manager')
export class BranchManagerController {
  constructor(
    private readonly staff: ManagerStaffService,
    private readonly operations: ManagerOperationsService,
    private readonly reports: ManagerReportsService,
    private readonly realtime: RealtimePublisher,
  ) {}

  @Get('staff')
  @ApiOperation({ summary: 'BM-01: List Cashier/Barista accounts in your assigned branch' })
  listStaff(@CurrentUser() user: AuthenticatedUser, @Query() query: ManagerStaffQueryDto) {
    return this.staff.list(user, query);
  }

  @Post('staff')
  @ApiOperation({
    summary: 'BM-01: Create a Cashier/Barista within the chain account quota',
    description:
      'Branch is derived from the JWT. Returns staff profile without passwords or login tokens.',
  })
  createStaff(@CurrentUser() user: AuthenticatedUser, @Body() dto: ManagerCreateStaffDto) {
    return this.staff.create(user, dto);
  }

  @Get('staff/:employeeId')
  @ApiOperation({ summary: 'BM-01: Get a Cashier/Barista profile in your branch' })
  getStaff(
    @CurrentUser() user: AuthenticatedUser,
    @Param('employeeId', new ParseUUIDPipe()) id: string,
  ) {
    return this.staff.get(user, id);
  }

  @Patch('staff/:employeeId')
  @ApiOperation({
    summary: 'BM-01: Update Cashier/Barista profile or switch between these two roles',
  })
  updateStaff(
    @CurrentUser() user: AuthenticatedUser,
    @Param('employeeId', new ParseUUIDPipe()) id: string,
    @Body() dto: ManagerUpdateStaffDto,
  ) {
    return this.staff.update(user, id, dto);
  }

  @Patch('staff/:employeeId/status')
  @ApiOperation({
    summary: 'BM-01: Lock/unlock an account with an audited reason; locking revokes sessions',
  })
  staffStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('employeeId', new ParseUUIDPipe()) id: string,
    @Body() dto: ManagerStaffStatusDto,
  ) {
    return this.staff.status(user, id, dto);
  }

  @Post('staff/:employeeId/reset-password')
  @HttpCode(200)
  @ApiOperation({
    summary: 'BM-01: Send a one-time password setup link and revoke all sessions',
  })
  resetPassword(
    @CurrentUser() user: AuthenticatedUser,
    @Param('employeeId', new ParseUUIDPipe()) id: string,
    @Body() dto: ManagerResetPasswordDto,
  ) {
    return this.staff.resetPassword(user, id, dto);
  }

  @Get('menu-options')
  @ApiOperation({ summary: 'BM-02: List chain options and branch/effective availability' })
  options(@CurrentUser() user: AuthenticatedUser) {
    return this.operations.options(user);
  }

  @Patch('menu-options/:optionId/availability')
  @ApiOperation({
    summary: 'BM-02: Switch an option on/off in your branch',
    description:
      'Cannot override Owner chain-wide switches. Publishes availability and paid-order stock alerts.',
  })
  async availability(
    @CurrentUser() user: AuthenticatedUser,
    @Param('optionId', new ParseUUIDPipe()) id: string,
    @Body() dto: ManagerAvailabilityDto,
  ) {
    const result = await this.operations.optionAvailability(user, id, dto.isAvailable);
    this.realtime.branch(user.branchId!, 'menu.availability.changed', result);
    if (result.affectedOrderIds.length)
      this.realtime.branch(user.branchId!, 'manager.order.attention-required', {
        reason: 'OPTION_OUT_OF_STOCK',
        optionId: id,
        orderIds: result.affectedOrderIds,
      });
    return result;
  }

  @Get('reports')
  @ApiOperation({
    summary:
      'BM-03: Branch revenue, payment methods, best sellers, hourly orders, preparation and cancellations',
    description:
      'Dates use branch timezone. Revenue is paid, non-cancelled sales by paidAt. Payments separately show settled/received amounts. TOPPING/TOPPINGS group codes identify toppings. Cancelled orders are a limited preview; use order search for full history.',
  })
  report(@CurrentUser() user: AuthenticatedUser, @Query() query: ManagerReportQueryDto) {
    return this.reports.report(user, query);
  }

  @Get('orders')
  @ApiOperation({
    summary: 'BM-04: Search orders by code, call number, date range, statuses and payment method',
    description:
      'Pagination; only your branch. from is inclusive, to exclusive, based on placedAt. Call numbers repeat each business day; use date filters.',
  })
  orders(@CurrentUser() user: AuthenticatedUser, @Query() query: ManagerOrderQueryDto) {
    return this.operations.orders(user, query);
  }

  @Get('orders/:orderId')
  @ApiOperation({
    summary: 'BM-04: Order snapshots, creators, payment history and audit',
    description:
      'Table-session payments are returned separately and may cover several orders. No PayOS credentials or raw webhook payloads are returned.',
  })
  order(@CurrentUser() user: AuthenticatedUser, @Param('orderId', new ParseUUIDPipe()) id: string) {
    return this.operations.order(user, id);
  }

  @Get('audit-logs')
  @ApiOperation({ summary: 'Read append-only audit history for your branch' })
  audit(@CurrentUser() user: AuthenticatedUser, @Query() query: ManagerAuditQueryDto) {
    return this.operations.audit(user, query);
  }
}
