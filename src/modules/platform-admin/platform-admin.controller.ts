import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
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
  ApproveRegistrationApplicationDto,
  ChangeSubscriptionPlanDto,
  ConfirmWithdrawalTransferDto,
  CreateServicePlanDto,
  ListRegistrationApplicationsQueryDto,
  ListWithdrawalRequestsQueryDto,
  PaginationQueryDto,
  RejectRegistrationApplicationDto,
  RenewSubscriptionDto,
  SubscriptionStatusReasonDto,
  UpdatePlatformFinanceConfigDto,
  UpdateServicePlanDto,
  WithdrawalReasonDto,
} from './dto/platform-admin.dto.js';
import { PlatformAdminService } from './platform-admin.service.js';
import { PlatformFinanceService } from './platform-finance.service.js';

@Roles(AppRole.ADMIN)
@ApiTags('Platform administration')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiUnauthorizedResponse({ description: 'Access token is missing, invalid, or expired' })
@ApiForbiddenResponse({ description: 'Only a platform ADMIN can use this endpoint' })
@Controller('admin')
export class PlatformAdminController {
  constructor(
    private readonly platformAdminService: PlatformAdminService,
    private readonly platformFinanceService: PlatformFinanceService,
  ) {}

  @Get('registration-applications')
  @ApiOperation({ summary: 'List and search business registration applications' })
  listApplications(@Query() query: ListRegistrationApplicationsQueryDto) {
    return this.platformAdminService.listRegistrationApplications(query);
  }

  @Get('registration-applications/:id')
  @ApiOperation({ summary: 'View a registration application and issued Owner status' })
  getApplication(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.platformAdminService.getRegistrationApplication(id);
  }

  @Post('registration-applications/:id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve an application and provision business, wallet, branding, and Owner',
    description: 'Queues the Owner setup email in the transactional email outbox.',
  })
  @ApiConflictResponse({ description: 'Application already reviewed or Owner identity conflicts' })
  approveApplication(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ApproveRegistrationApplicationDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.platformAdminService.approveRegistrationApplication(id, dto, admin.id);
  }

  @Post('registration-applications/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a pending registration application with a reason' })
  rejectApplication(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RejectRegistrationApplicationDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.platformAdminService.rejectRegistrationApplication(id, dto.reason, admin.id);
  }

  @Get('service-plans')
  @ApiOperation({ summary: 'List service plans' })
  listPlans() {
    return this.platformAdminService.listServicePlans();
  }

  @Post('service-plans')
  @ApiOperation({ summary: 'Define a service plan and its resource limits' })
  createPlan(@Body() dto: CreateServicePlanDto) {
    return this.platformAdminService.createServicePlan(dto);
  }

  @Patch('service-plans/:id')
  @ApiOperation({ summary: 'Update or deactivate a service plan' })
  updatePlan(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateServicePlanDto) {
    return this.platformAdminService.updateServicePlan(id, dto);
  }

  @Get('businesses')
  @ApiOperation({ summary: 'List businesses with plan, expiry, usage, and monthly order count' })
  listBusinesses(@Query() query: PaginationQueryDto) {
    return this.platformAdminService.listBusinesses(query);
  }

  @Get('businesses/:id')
  @ApiOperation({
    summary: 'View a business profile and aggregate usage',
    description: 'Does not expose orders, menus, item prices, employee names, or cash revenue.',
  })
  getBusiness(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.platformAdminService.getBusiness(id);
  }

  @Post('businesses/:id/subscription/renew')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Renew a business subscription' })
  renewSubscription(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RenewSubscriptionDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.platformAdminService.renewSubscription(id, dto, admin.id);
  }

  @Post('businesses/:id/subscription/change-plan')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Upgrade or downgrade a business service plan' })
  changePlan(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ChangeSubscriptionPlanDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.platformAdminService.changeSubscriptionPlan(id, dto, admin.id);
  }

  @Post('businesses/:id/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Suspend a business subscription and revoke its sessions' })
  suspendBusiness(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SubscriptionStatusReasonDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.platformAdminService.suspendBusiness(id, dto, admin.id);
  }

  @Post('businesses/:id/reactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reactivate a non-expired business subscription' })
  reactivateBusiness(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SubscriptionStatusReasonDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.platformAdminService.reactivateBusiness(id, dto, admin.id);
  }

  @Post('owners/:ownerId/reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Queue a one-time password setup email for an Owner' })
  resetOwnerPassword(
    @Param('ownerId', new ParseUUIDPipe()) ownerId: string,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.platformAdminService.resetOwnerPassword(ownerId, admin.id);
  }

  @Get('finance/config')
  @ApiOperation({ summary: 'View payment fee, holding period, and minimum withdrawal settings' })
  getFinanceConfig() {
    return this.platformFinanceService.getFinanceConfig();
  }

  @Patch('finance/config')
  @ApiOperation({ summary: 'Update platform finance settings' })
  updateFinanceConfig(
    @Body() dto: UpdatePlatformFinanceConfigDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.platformFinanceService.updateFinanceConfig(dto, admin.id);
  }

  @Get('businesses/:id/wallet')
  @ApiOperation({ summary: 'View a business wallet balance and immutable ledger' })
  getBusinessWallet(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.platformFinanceService.getBusinessWallet(id, query);
  }

  @Get('withdrawals')
  @ApiOperation({ summary: 'List and search withdrawal requests' })
  listWithdrawals(@Query() query: ListWithdrawalRequestsQueryDto) {
    return this.platformFinanceService.listWithdrawalRequests(query);
  }

  @Get('withdrawals/:id')
  @ApiOperation({ summary: 'View a withdrawal request' })
  getWithdrawal(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.platformFinanceService.getWithdrawalRequest(id);
  }

  @Post('withdrawals/:id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a pending withdrawal request' })
  approveWithdrawal(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.platformFinanceService.approveWithdrawalRequest(id, admin.id);
  }

  @Post('withdrawals/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a pending withdrawal request and release held funds' })
  rejectWithdrawal(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: WithdrawalReasonDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.platformFinanceService.rejectWithdrawalRequest(id, dto.reason, admin.id);
  }

  @Post('withdrawals/:id/confirm-transfer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm a real bank transfer and record its transaction code' })
  confirmWithdrawalTransfer(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ConfirmWithdrawalTransferDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.platformFinanceService.confirmWithdrawalTransfer(id, dto, admin.id);
  }

  @Post('withdrawals/:id/transfer-failed')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark an approved transfer as failed and release held funds' })
  markWithdrawalFailed(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: WithdrawalReasonDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.platformFinanceService.markWithdrawalTransferFailed(id, dto.reason, admin.id);
  }
}
