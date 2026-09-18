import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
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
  CreateWithdrawalRequestDto,
  ListWithdrawalRequestsQueryDto,
} from './dto/platform-admin.dto.js';
import { PlatformFinanceService } from './platform-finance.service.js';

@Roles(AppRole.OWNER)
@ApiTags('Owner finance')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiUnauthorizedResponse({ description: 'Access token is missing, invalid, or expired' })
@ApiForbiddenResponse({ description: 'Only an OWNER can use this endpoint' })
@Controller('owner/withdrawals')
export class OwnerFinanceController {
  constructor(private readonly platformFinanceService: PlatformFinanceService) {}

  @Post()
  @ApiOperation({ summary: 'Request a withdrawal from an assigned business wallet' })
  create(@Body() dto: CreateWithdrawalRequestDto, @CurrentUser() owner: AuthenticatedUser) {
    return this.platformFinanceService.createWithdrawalRequest(dto, owner);
  }

  @Get()
  @ApiOperation({ summary: 'List withdrawal requests for businesses assigned to the Owner' })
  list(@Query() query: ListWithdrawalRequestsQueryDto, @CurrentUser() owner: AuthenticatedUser) {
    return this.platformFinanceService.listOwnerWithdrawals(query, owner);
  }
}
