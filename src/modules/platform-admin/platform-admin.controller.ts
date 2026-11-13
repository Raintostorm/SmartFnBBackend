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
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiBearerAuth,
  ApiConflictResponse,
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
  ApproveRegistrationApplicationDto,
  ChangeApprovedPlanDto,
  CreateServicePlanDto,
  ListRegistrationApplicationsQueryDto,
  NextPeriodDraftQueryDto,
  PaginationQueryDto,
  PlatformSupportNoteDto,
  RejectRegistrationApplicationDto,
  RenewSubscriptionDto,
  SubscriptionStatusReasonDto,
  SupportNextPeriodDto,
  UpdateServicePlanDto,
} from './dto/platform-admin.dto.js';
import { PlatformAdminService } from './platform-admin.service.js';
import { PasswordResetService } from '../auth/password-reset.service.js';

@Roles(AppRole.ADMIN)
@ApiTags('Platform administration')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiUnauthorizedResponse({ description: 'Access token is missing, invalid, or expired' })
@ApiForbiddenResponse({ description: 'Only a platform ADMIN can use this endpoint' })
@Controller('admin')
export class PlatformAdminController {
  constructor(
    private readonly platformAdminService: PlatformAdminService,
    private readonly resets: PasswordResetService,
  ) {}

  @Get('registration-applications')
  @ApiOperation({ summary: 'List and search business registration applications' })
  listApplications(@Query() query: ListRegistrationApplicationsQueryDto) {
    return this.platformAdminService.listRegistrationApplications(query);
  }

  @Get('registration-applications/:id')
  @ApiOperation({ summary: 'View a registration application and issued Brand Manager status' })
  getApplication(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.platformAdminService.getRegistrationApplication(id);
  }

  @Post('registration-applications/:id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve an application and provision business, branding, and Brand Manager',
    description: 'Queues the Brand Manager setup email in the transactional email outbox.',
  })
  @ApiConflictResponse({ description: 'Application already reviewed or Brand Manager identity conflicts' })
  approveApplication(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ApproveRegistrationApplicationDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.platformAdminService.approveRegistrationApplication(id, dto, admin.id);
  }

  @Post('registration-applications/:id/change-approved-plan')
  changeApprovedPlan(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ChangeApprovedPlanDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.platformAdminService.changeApprovedPlan(id, dto.planId, dto.note, admin.id);
  }

  @Post('registration-applications/:id/resend-activation')
  resendActivation(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: PlatformSupportNoteDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.platformAdminService.resendActivation(id, dto.note, admin.id);
  }

  @Post('registration-applications/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject a pending registration application with a reason',
    description: 'Queues a rejection email in the transactional email outbox.',
  })
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
  @ApiOperation({ summary: 'Define a service plan, resource limits, and enabled features' })
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

  @Post('businesses/:id/next-plan')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Register a plan for the next unpaid subscription period' })
  scheduleNextPlan(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ChangeApprovedPlanDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.platformAdminService.scheduleNextPlan(id, dto.planId, dto.note, admin.id, 'PLATFORM_ADMIN');
  }

  @Get('businesses/:id/next-period')
  @ApiOperation({ summary: 'Next-period preview, keep candidates and invoices of a business' })
  nextPeriod(@Param('id', new ParseUUIDPipe()) id: string, @Query() query: NextPeriodDraftQueryDto) {
    const draft = query.planId !== undefined || query.extraBranches !== undefined || query.accountPacks !== undefined ? query : undefined;
    return this.platformAdminService.getNextPeriod(id, draft);
  }

  @Put('businesses/:id/next-period')
  @ApiOperation({ summary: 'Register plan and add-ons for the next period (never changes the current period)' })
  scheduleNextPeriod(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: SupportNextPeriodDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.platformAdminService.scheduleNextPeriod(id, dto, admin.id, 'PLATFORM_ADMIN');
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

  /** Kept for compatibility; same service and policy as POST /platform-staff/owners/:ownerId/reset-password (Admin inherits Staff). */
  @Post('owners/:ownerId/reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Alias of the Platform Staff Brand Manager password reset (note required)' })
  resetOwnerPassword(
    @Param('ownerId', new ParseUUIDPipe()) ownerId: string,
    @Body() dto: PlatformSupportNoteDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.resets.resetBrandManager(admin, ownerId, dto.note, { ipAddress: request.ip });
  }
}
