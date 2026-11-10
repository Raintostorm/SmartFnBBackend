import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { IsInt, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import { AppRole } from '../auth/app-role.enum.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PlanQuotaService } from '../subscription/plan-quota.service.js';
import { ApiAuthenticatedOperation, ApiUuidPath } from '../../common/swagger/swagger.decorators.js';
import { BranchAccessService } from './branch-access.service.js';
import { ChainSubscriptionResponseDto } from './dto/branch-response.dto.js';
import { SubscriptionScheduleService } from '../subscription/subscription-schedule.service.js';

class NextPlanDto { @IsUUID() planId!: string; }
class NextAddonsDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(10) extraBranches!: number;
  @Type(() => Number) @IsInt() @Min(0) @Max(4) accountPacks!: number;
}

@ApiTags('Restaurant chain subscription')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiAuthenticatedOperation()
@Roles(AppRole.OWNER, AppRole.MANAGER)
@Controller('restaurant-chains/:chainId/subscription')
export class ChainSubscriptionController {
  constructor(
    private readonly access: BranchAccessService,
    private readonly quota: PlanQuotaService,
    private readonly schedule: SubscriptionScheduleService,
  ) {}

  @Get()
  @ApiUuidPath('chainId', 'Restaurant chain')
  @ApiOperation({ summary: 'Read plan status, expiration, features, and quota usage' })
  @ApiOkResponse({ type: ChainSubscriptionResponseDto })
  async get(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.access.assertCanReadChain(user, chainId);
    return { subscription: await this.quota.getSubscriptionSnapshot(chainId) };
  }

  @Get('next-invoice-preview')
  @Roles(AppRole.OWNER)
  async preview(@Param('chainId', new ParseUUIDPipe()) chainId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.access.assertCanAccessChain(user, chainId);
    return this.schedule.preview(chainId);
  }

  @Get('invoices')
  @Roles(AppRole.OWNER)
  async invoices(@Param('chainId', new ParseUUIDPipe()) chainId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.access.assertCanAccessChain(user, chainId);
    return this.schedule.listInvoices(chainId);
  }

  @Put('next-plan')
  @Roles(AppRole.OWNER)
  async putNextPlan(@Param('chainId', new ParseUUIDPipe()) chainId: string, @Body() dto: NextPlanDto, @CurrentUser() user: AuthenticatedUser) {
    await this.access.assertCanAccessChain(user, chainId);
    return this.schedule.putNextPlan(chainId, dto.planId);
  }

  @Delete('next-plan')
  @Roles(AppRole.OWNER)
  async clearNextPlan(@Param('chainId', new ParseUUIDPipe()) chainId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.access.assertCanAccessChain(user, chainId);
    return this.schedule.clearNextPlan(chainId);
  }

  @Put('next-addons')
  @Roles(AppRole.OWNER)
  async putNextAddons(@Param('chainId', new ParseUUIDPipe()) chainId: string, @Body() dto: NextAddonsDto, @CurrentUser() user: AuthenticatedUser) {
    await this.access.assertCanAccessChain(user, chainId);
    return this.schedule.putNextAddons(chainId, dto.extraBranches, dto.accountPacks);
  }
}
