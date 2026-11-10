import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { ArrayMaxSize, ArrayUnique, IsArray, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
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

/** BR-11 selection sent with a registration that lowers the next-period limits. */
export class KeepSelectionDto {
  @ApiPropertyOptional({ type: [String], description: 'Branch ids kept active from the next period (BR-11)' })
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ArrayUnique() @IsUUID('all', { each: true })
  keepBranchIds?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Employee ids (staff accounts) kept unlocked from the next period; Brand Managers are always kept' })
  @IsOptional() @IsArray() @ArrayMaxSize(500) @ArrayUnique() @IsUUID('all', { each: true })
  keepAccountIds?: string[];
}
export class NextPlanDto extends KeepSelectionDto { @IsUUID() planId!: string; }
export class NextAddonsDto extends KeepSelectionDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(10) extraBranches!: number;
  @Type(() => Number) @IsInt() @Min(0) @Max(4) accountPacks!: number;
}
/** Plan and add-ons in one registration (31.3): avoids re-deriving add-ons between two calls. */
export class NextPeriodDto extends KeepSelectionDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() planId?: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(10) extraBranches!: number;
  @Type(() => Number) @IsInt() @Min(0) @Max(4) accountPacks!: number;
}
export class NextPreviewQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() planId?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10) extraBranches?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10) accountPacks?: number;
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
  @ApiOperation({ summary: 'Next-period invoice preview; with query params, a dry run of an unsaved registration (BR-92, BR-11)' })
  async preview(@Param('chainId', new ParseUUIDPipe()) chainId: string, @Query() query: NextPreviewQueryDto, @CurrentUser() user: AuthenticatedUser) {
    await this.access.assertCanAccessChain(user, chainId);
    const draft = query.planId !== undefined || query.extraBranches !== undefined || query.accountPacks !== undefined ? query : undefined;
    return this.schedule.preview(chainId, draft);
  }

  @Get('keep-candidates')
  @Roles(AppRole.OWNER)
  @ApiOperation({ summary: 'Branches and staff accounts that can be kept when the next-period limit shrinks (BR-11)' })
  async keepCandidates(@Param('chainId', new ParseUUIDPipe()) chainId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.access.assertCanAccessChain(user, chainId);
    return this.schedule.keepCandidates(chainId);
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
    return this.schedule.putNextPlan(chainId, dto.planId, dto, { role: 'BRAND_MANAGER', userId: user.id });
  }

  @Delete('next-plan')
  @Roles(AppRole.OWNER)
  async clearNextPlan(@Param('chainId', new ParseUUIDPipe()) chainId: string, @Body() dto: KeepSelectionDto, @CurrentUser() user: AuthenticatedUser) {
    await this.access.assertCanAccessChain(user, chainId);
    return this.schedule.clearNextPlan(chainId, dto ?? {}, { role: 'BRAND_MANAGER', userId: user.id });
  }

  @Put('next-period')
  @Roles(AppRole.OWNER)
  @ApiOperation({ summary: 'Register plan + add-ons (+ BR-11 keep lists) for the next unpaid period in one call' })
  async putNextPeriod(@Param('chainId', new ParseUUIDPipe()) chainId: string, @Body() dto: NextPeriodDto, @CurrentUser() user: AuthenticatedUser) {
    await this.access.assertCanAccessChain(user, chainId);
    return this.schedule.register(chainId, dto, { role: 'BRAND_MANAGER', userId: user.id });
  }

  @Put('next-addons')
  @Roles(AppRole.OWNER)
  async putNextAddons(@Param('chainId', new ParseUUIDPipe()) chainId: string, @Body() dto: NextAddonsDto, @CurrentUser() user: AuthenticatedUser) {
    await this.access.assertCanAccessChain(user, chainId);
    return this.schedule.putNextAddons(chainId, dto.extraBranches, dto.accountPacks, dto, { role: 'BRAND_MANAGER', userId: user.id });
  }
}
