import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import {
  ConfirmPlatformInvoiceDto,
  ListPlatformInvoicesQueryDto,
  PlatformRevenueQueryDto,
} from '../platform-admin/dto/platform-admin.dto.js';
import { PlatformAdminService } from '../platform-admin/platform-admin.service.js';
import { PlatformAdminAnalyticsService } from './platform-admin-analytics.service.js';
import { PlatformBillingService } from './platform-billing.service.js';

@Roles(AppRole.ADMIN)
@ApiTags('Platform administration')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@Controller('admin')
export class PlatformAdminAnalyticsController {
  constructor(
    private readonly analytics: PlatformAdminAnalyticsService,
    private readonly billing: PlatformBillingService,
    private readonly registrations: PlatformAdminService,
  ) {}

  @Get('overview')
  @ApiOperation({ summary: 'Return exact platform administration KPIs' })
  overview() {
    return this.analytics.overview();
  }

  @Get('platform-revenue')
  @ApiOperation({
    summary: 'Report collected subscription revenue only; restaurant sales are excluded',
  })
  revenue(@Query() query: PlatformRevenueQueryDto) {
    return this.analytics.revenue(query);
  }

  @Get('platform-billing/invoices')
  @ApiOperation({ summary: 'List first-payment and recurring platform subscription invoices' })
  invoices(@Query() query: ListPlatformInvoicesQueryDto) {
    return this.analytics.listInvoices(query);
  }

  @Post('platform-billing/invoices/:source/:id/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Manually confirm a mismatched platform invoice with an audit note' })
  confirm(
    @Param('source') source: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ConfirmPlatformInvoiceDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    if (source === 'subscription')
      return this.billing.confirmCheckoutManually(id, dto.note, actor.id);
    if (source === 'registration')
      return this.registrations.confirmRegistrationCheckoutManually(id, dto.note, actor.id);
    throw new BadRequestException('Unsupported platform invoice source');
  }
}
