import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import {
  ReportRangeQueryDto,
  RevenueTimeseriesQueryDto,
  TopItemsQueryDto,
} from './dto/report.dto.js';
import { ReportsService } from './reports.service.js';

@Roles(AppRole.OWNER)
@ApiTags('Reports - OWNER')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiUnauthorizedResponse({ description: 'Access token is missing, invalid, or expired' })
@ApiForbiddenResponse({ description: 'A requested branch is outside your assigned chains' })
@ApiBadRequestResponse({ description: 'Invalid date range' })
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('revenue/comparison')
  @ApiOperation({
    summary: 'Compare revenue across branches over one period',
    description:
      'One row per branch — revenue, orders, average order value, and guests — so the branches ' +
      'render on a single chart. Revenue counts COMPLETED orders by placedAt.',
  })
  @ApiOkResponse({ description: 'Per-branch revenue comparison' })
  compareBranches(@CurrentUser() user: AuthenticatedUser, @Query() query: ReportRangeQueryDto) {
    return this.reportsService.compareBranches(user, query);
  }

  @Get('revenue/timeseries')
  @ApiOperation({
    summary: 'Revenue over time by day, week, or month',
    description:
      'Returns one gap-filled series per branch sharing a single bucket list, so the branches ' +
      'stay aligned on the same axis.',
  })
  @ApiOkResponse({ description: 'Revenue series per branch' })
  getRevenueTimeseries(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: RevenueTimeseriesQueryDto,
  ) {
    return this.reportsService.getRevenueTimeseries(user, query);
  }

  @Get('top-items')
  @ApiOperation({
    summary: 'Best-selling menu items over the period',
    description: 'Ranked by quantity sold across every branch in scope.',
  })
  @ApiOkResponse({ description: 'Ranked menu items' })
  getTopItems(@CurrentUser() user: AuthenticatedUser, @Query() query: TopItemsQueryDto) {
    return this.reportsService.getTopItems(user, query);
  }

  @Get('customers')
  @ApiOperation({
    summary: 'Guests served per branch',
    description: 'Counted from the table sessions that reached PAID or CLOSED in the period.',
  })
  @ApiOkResponse({ description: 'Guest traffic per branch' })
  getCustomerTraffic(@CurrentUser() user: AuthenticatedUser, @Query() query: ReportRangeQueryDto) {
    return this.reportsService.getCustomerTraffic(user, query);
  }
}
