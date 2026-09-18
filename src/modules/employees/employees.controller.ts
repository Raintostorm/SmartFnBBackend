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
  ListEmployeesQueryDto,
  TransferEmployeeBranchDto,
  UpdateEmployeeAccountStatusDto,
} from './dto/employee.dto.js';
import { EmployeesService } from './employees.service.js';

@Roles(AppRole.OWNER)
@ApiTags('Employees - OWNER')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiUnauthorizedResponse({ description: 'Access token is missing, invalid, or expired' })
@ApiForbiddenResponse({ description: 'The employee is outside your assigned chains' })
@Controller('employees')
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Get()
  @ApiOperation({
    summary: 'List the staff of every branch the OWNER is assigned to',
    description:
      'Read-only roster covering all roles. Creating waiter and kitchen accounts is the Branch ' +
      'Manager job; the OWNER creates managers through POST /auth/managers.',
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
    summary: 'Lock or unlock a MANAGER account',
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
    summary: 'Send a password setup link to a MANAGER',
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
  ) {
    return this.employeesService.resetManagerPassword(user, employeeId);
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
