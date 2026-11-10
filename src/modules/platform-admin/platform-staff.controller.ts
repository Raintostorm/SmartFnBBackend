import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { ApproveRegistrationApplicationDto, ChangeApprovedPlanDto, ListRegistrationApplicationsQueryDto, NextPeriodDraftQueryDto, PaginationQueryDto, PlatformSupportNoteDto, RejectRegistrationApplicationDto, SupportNextPeriodDto } from './dto/platform-admin.dto.js';
import { PlatformAdminService } from './platform-admin.service.js';

@Roles(AppRole.PLATFORM_STAFF)
@ApiTags('Platform staff')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@Controller('platform-staff')
export class PlatformStaffController {
  constructor(private readonly service: PlatformAdminService) {}

  @Get('registration-applications')
  listApplications(@Query() query: ListRegistrationApplicationsQueryDto) { return this.service.listRegistrationApplications(query); }

  @Get('registration-applications/:id')
  getApplication(@Param('id', new ParseUUIDPipe()) id: string) { return this.service.getRegistrationApplication(id); }

  @Post('registration-applications/:id/approve')
  approve(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ApproveRegistrationApplicationDto, @CurrentUser() user: AuthenticatedUser) { return this.service.approveRegistrationApplication(id, dto, user.id); }

  @Post('registration-applications/:id/reject')
  reject(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: RejectRegistrationApplicationDto, @CurrentUser() user: AuthenticatedUser) { return this.service.rejectRegistrationApplication(id, dto.reason, user.id); }

  @Post('registration-applications/:id/change-approved-plan')
  changeApprovedPlan(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ChangeApprovedPlanDto, @CurrentUser() user: AuthenticatedUser) { return this.service.changeApprovedPlan(id, dto.planId, dto.note, user.id); }

  @Post('registration-applications/:id/resend-activation')
  resendActivation(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: PlatformSupportNoteDto, @CurrentUser() user: AuthenticatedUser) { return this.service.resendActivation(id, dto.note, user.id); }

  @Get('service-plans')
  listPlans() { return this.service.listServicePlans(); }

  @Get('businesses')
  listBusinesses(@Query() query: PaginationQueryDto) { return this.service.listBusinesses(query); }

  @Get('businesses/:id')
  getBusiness(@Param('id', new ParseUUIDPipe()) id: string) { return this.service.getBusiness(id); }

  @Post('businesses/:id/next-plan')
  scheduleNextPlan(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ChangeApprovedPlanDto, @CurrentUser() user: AuthenticatedUser) { return this.service.scheduleNextPlan(id, dto.planId, dto.note, user.id); }

  /** Preview, keep candidates and invoices of the next period for the support screen (PS-01). */
  @Get('businesses/:id/next-period')
  nextPeriod(@Param('id', new ParseUUIDPipe()) id: string, @Query() query: NextPeriodDraftQueryDto) {
    const draft = query.planId !== undefined || query.extraBranches !== undefined || query.accountPacks !== undefined ? query : undefined;
    return this.service.getNextPeriod(id, draft);
  }

  /** Register plan + add-ons (+ BR-11 keep lists) for the next period on the customer's request; note required. */
  @Put('businesses/:id/next-period')
  scheduleNextPeriod(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: SupportNextPeriodDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.scheduleNextPeriod(id, dto, user.id, 'PLATFORM_STAFF');
  }
}
