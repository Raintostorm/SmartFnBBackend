import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import {
  InviteManagerDto,
  InviteStaffDto,
  StaffInvitationReasonDto,
  ListEmployeesQueryDto,
  SetDirectStaffPasswordDto,
  TransferEmployeeBranchDto,
  UpdateEmployeeAccountStatusDto,
} from './dto/employee.dto.js';
import { EmployeesService } from './employees.service.js';
import { StaffAccountsService } from './staff-accounts.service.js';

@Roles(AppRole.OWNER)
@ApiTags('Employees - OWNER')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiUnauthorizedResponse({ description: 'Access token is missing, invalid, or expired' })
@ApiForbiddenResponse({ description: 'The employee is outside your assigned chains' })
@Controller('employees')
export class EmployeesController {
  constructor(
    private readonly employeesService: EmployeesService,
    private readonly accounts: StaffAccountsService,
  ) {}

  @Post('managers')
  @ApiOperation({ summary: 'Invite a MANAGER by email without choosing their password' })
  @ApiOkResponse({ description: 'Inactive manager created and password setup email queued' })
  inviteManager(@CurrentUser() user: AuthenticatedUser, @Body() dto: InviteManagerDto) {
    return this.employeesService.inviteManager(user, dto);
  }

  @Post('invitations')
  @ApiOperation({
    summary: 'Invite Manager, Cashier or Barista by email (24-hour activation link)',
  })
  createAccount(@CurrentUser() user: AuthenticatedUser, @Body() dto: InviteStaffDto) {
    const [firstName, ...rest] = dto.name.trim().split(/\s+/);
    return this.accounts.invite(user, { ...dto, firstName, lastName: rest.join(' ') });
  }

  @Post(':employeeId/invitation/resend')
  @ApiOperation({ summary: 'Resend pending invitation; replaces old link, 60-second cooldown' })
  resendInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('employeeId', new ParseUUIDPipe()) id: string,
    @Body() dto: StaffInvitationReasonDto,
  ) {
    return this.accounts.sendSetup(user, id, dto.reason, true);
  }

  @Post(':employeeId/invitation/cancel')
  @ApiOperation({ summary: 'Cancel pending invitation and invalidate its token' })
  cancelInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('employeeId', new ParseUUIDPipe()) id: string,
    @Body() dto: StaffInvitationReasonDto,
  ) {
    return this.accounts.cancel(user, id, dto.reason);
  }

  @Get()
  @ApiOperation({
    summary: 'List the staff of every branch the OWNER is assigned to',
    description:
      'Roster covering all roles. The OWNER can create Manager, Cashier and Barista accounts ' +
      'through POST /employees/invitations. All new accounts require email activation.',
  })
  @ApiOkResponse({ description: 'Paginated staff roster' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListEmployeesQueryDto) {
    return this.employeesService.listEmployees(user, query);
  }

  @Get(':employeeId')
  @ApiOperation({ summary: 'Get one employee in the OWNER scope' })
  @ApiParam({ name: 'employeeId', format: 'uuid' })
  @ApiOkResponse({ description: 'Employee detail' })
  @ApiNotFoundResponse({ description: 'Employee not found in your scope' })
  get(
    @Param('employeeId', new ParseUUIDPipe()) employeeId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.employeesService.getEmployee(user, employeeId);
  }

  @Patch(':employeeId/status')
  @ApiOperation({
    summary: 'Lock or unlock a Manager, Cashier or Barista account',
    description: 'Any status other than ACTIVE also revokes the live sessions of that manager.',
  })
  @ApiParam({ name: 'employeeId', format: 'uuid' })
  @ApiOkResponse({ description: 'Account status updated' })
  @ApiForbiddenResponse({ description: 'The target is not a MANAGER, or it is your own account' })
  @ApiNotFoundResponse({ description: 'Employee not found in your scope' })
  updateStatus(
    @Param('employeeId', new ParseUUIDPipe()) employeeId: string,
    @Body() dto: UpdateEmployeeAccountStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.employeesService.updateManagerAccountStatus(user, employeeId, dto);
  }

  @Post(':employeeId/reset-password')
  @ApiOperation({
    summary: 'Send a password setup link to a Manager, Cashier or Barista',
    description:
      'Revokes the live sessions and emails a one-time link valid for 24 hours. The token is ' +
      'never returned in the response.',
  })
  @ApiParam({ name: 'employeeId', format: 'uuid' })
  @ApiOkResponse({ description: 'Password setup link queued' })
  @ApiForbiddenResponse({ description: 'The target is not a MANAGER account' })
  @ApiNotFoundResponse({ description: 'Employee not found in your scope' })
  resetPassword(
    @Param('employeeId', new ParseUUIDPipe()) employeeId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: StaffInvitationReasonDto,
  ) {
    return this.employeesService.resetManagerPassword(user, employeeId, dto.reason);
  }

  @Patch(':employeeId/password')
  @ApiOperation({
    summary: 'Set password for an Owner-created staff account and revoke its sessions',
  })
  setPassword(
    @Param('employeeId', new ParseUUIDPipe()) employeeId: string,
    @Body() dto: SetDirectStaffPasswordDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.employeesService.setDirectPassword(user, employeeId, dto);
  }

  @Patch(':employeeId/branch')
  @ApiOperation({
    summary: 'Move a MANAGER to another branch of the same chain',
    description: 'The manager signs in again afterwards, because the token carries the branch.',
  })
  @ApiParam({ name: 'employeeId', format: 'uuid' })
  @ApiOkResponse({ description: 'Manager transferred' })
  @ApiForbiddenResponse({ description: 'The target is not a MANAGER account' })
  @ApiNotFoundResponse({ description: 'Target branch not found in the same restaurant chain' })
  transferBranch(
    @Param('employeeId', new ParseUUIDPipe()) employeeId: string,
    @Body() dto: TransferEmployeeBranchDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.employeesService.transferManagerBranch(user, employeeId, dto);
  }
}
