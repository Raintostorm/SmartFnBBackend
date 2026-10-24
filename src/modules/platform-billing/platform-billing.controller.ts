import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PlatformBillingService } from './platform-billing.service.js';
import { StartCheckoutDto } from './dto/start-checkout.dto.js';

@ApiTags('Platform subscription billing')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@Roles(AppRole.OWNER)
@Controller('restaurant-chains/:chainId/subscription')
export class PlatformBillingController {
  constructor(private readonly billing: PlatformBillingService) {}

  @Post('checkouts')
  @ApiOperation({ summary: 'Start one-month platform PayOS checkout for a trial business' })
  createCheckout(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Body() body: StartCheckoutDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.billing.createCheckout(user, chainId, body.planId);
  }

  @Get('checkouts/:checkoutId')
  @ApiOperation({ summary: 'Read platform checkout status; redirect alone never activates a plan' })
  getCheckout(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('checkoutId', new ParseUUIDPipe()) checkoutId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.billing.getCheckout(user, chainId, checkoutId);
  }
}

@Public()
@ApiTags('Platform subscription billing')
@Controller('webhooks/payos/platform')
export class PlatformBillingWebhookController {
  constructor(private readonly billing: PlatformBillingService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify platform PayOS payment and activate a paid plan' })
  receive(@Body() payload: Record<string, unknown>) {
    return this.billing.webhook(payload);
  }
}

@ApiTags('Platform subscription billing')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@Roles(AppRole.ADMIN)
@Controller('admin/platform-billing')
export class PlatformBillingAdminController {
  constructor(private readonly billing: PlatformBillingService) {}

  @Post('confirm-webhook')
  @HttpCode(200)
  @ApiOperation({ summary: 'Register the SmartFnB merchant webhook with PayOS' })
  confirmWebhook() {
    return this.billing.confirmWebhook();
  }
}
