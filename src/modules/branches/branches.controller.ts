import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
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
import { BranchesService } from './branches.service.js';
import {
  CreateBranchAreaDto,
  UpdateBranchAreaDto,
  UpdateBranchAreaStatusDto,
} from './dto/branch-area.dto.js';
import { ListBranchesQueryDto, UpdateBranchDto, UpdateBranchStatusDto } from './dto/branch.dto.js';
import { UpsertBranchHourDto, UpsertBranchSpecialHourDto } from './dto/branch-hours.dto.js';
import { BranchDetailResponseDto, BranchResponseDto } from './dto/branch-response.dto.js';

const INTERNAL_BRANCH_ROLES = [
  AppRole.OWNER,
  AppRole.MANAGER,
  AppRole.WAITER,
  AppRole.KITCHEN,
  AppRole.CASHIER,
];

@Roles(...INTERNAL_BRANCH_ROLES)
@ApiTags('Branches - internal')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiUnauthorizedResponse({ description: 'Access token is missing, invalid, or expired' })
@ApiForbiddenResponse({
  description: 'Role is not allowed or employee tried to access another branch',
})
@Controller('branches')
export class BranchesController {
  constructor(private readonly branchesService: BranchesService) {}

  @Get()
  @ApiOperation({
    summary: 'List branches: OWNER sees owned chains; staff see their assigned branch',
  })
  @ApiOkResponse({ description: 'Accessible branches', type: BranchResponseDto, isArray: true })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListBranchesQueryDto) {
    return this.branchesService.listBranches(user, query);
  }

  @Get(':branchId')
  @ApiOperation({ summary: 'Get accessible branch detail, hours, and role-visible areas' })
  @ApiParam({ name: 'branchId', format: 'uuid' })
  @ApiOkResponse({ description: 'Branch detail', type: BranchDetailResponseDto })
  @ApiNotFoundResponse({ description: 'Branch not found' })
  get(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.branchesService.getBranch(branchId, user);
  }

  @Roles(AppRole.OWNER, AppRole.MANAGER)
  @Patch(':branchId')
  @ApiOperation({ summary: 'Update branch information (OWNER or assigned MANAGER)' })
  @ApiParam({ name: 'branchId', format: 'uuid' })
  @ApiOkResponse({ description: 'Branch updated', type: BranchResponseDto })
  @ApiConflictResponse({ description: 'Branch code already exists' })
  @ApiNotFoundResponse({ description: 'Branch not found' })
  update(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Body() dto: UpdateBranchDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.branchesService.updateBranch(branchId, dto, user);
  }

  @Roles(AppRole.OWNER, AppRole.MANAGER)
  @Patch(':branchId/status')
  @ApiOperation({
    summary: 'Change branch status (OWNER or assigned MANAGER)',
    description: 'MANAGER may set ACTIVE or MAINTENANCE; OWNER may also set INACTIVE.',
  })
  @ApiParam({ name: 'branchId', format: 'uuid' })
  @ApiOkResponse({ description: 'Branch status updated', type: BranchResponseDto })
  @ApiNotFoundResponse({ description: 'Branch not found' })
  updateStatus(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Body() dto: UpdateBranchStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.branchesService.updateBranchStatus(branchId, dto.status, user);
  }

  @Roles(AppRole.OWNER)
  @Delete(':branchId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive a branch and release its subscription quota' })
  @ApiParam({ name: 'branchId', format: 'uuid' })
  @ApiOkResponse({ description: 'Branch archived', type: BranchResponseDto })
  @ApiConflictResponse({ description: 'Branch still has an open table session' })
  @ApiNotFoundResponse({ description: 'Branch not found' })
  deleteBranch(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.branchesService.deleteBranch(branchId, user);
  }

  @Get(':branchId/operating-hours')
  @ApiOperation({ summary: 'List weekly operating hours for an accessible branch' })
  @ApiParam({ name: 'branchId', format: 'uuid' })
  @ApiOkResponse({ description: 'Weekly operating hours; dayOfWeek is 0=Sunday to 6=Saturday' })
  listOperatingHours(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.branchesService.listOperatingHours(branchId, user);
  }

  @Roles(AppRole.OWNER, AppRole.MANAGER)
  @Put(':branchId/operating-hours/:dayOfWeek')
  @ApiOperation({
    summary: 'Create or replace a weekly operating hour (OWNER or assigned MANAGER)',
  })
  @ApiParam({ name: 'branchId', format: 'uuid' })
  @ApiParam({
    name: 'dayOfWeek',
    schema: { type: 'integer', minimum: 0, maximum: 6 },
  })
  @ApiOkResponse({ description: 'Operating hour saved' })
  @ApiBadRequestResponse({ description: 'Invalid day or time pair' })
  upsertOperatingHour(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Param('dayOfWeek', ParseIntPipe) dayOfWeek: number,
    @Body() dto: UpsertBranchHourDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.branchesService.upsertOperatingHour(branchId, dayOfWeek, dto, user);
  }

  @Get(':branchId/special-hours')
  @ApiOperation({ summary: 'List holiday/special operating hours for an accessible branch' })
  @ApiParam({ name: 'branchId', format: 'uuid' })
  @ApiOkResponse({ description: 'Special operating hours' })
  listSpecialHours(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.branchesService.listSpecialHours(branchId, user);
  }

  @Roles(AppRole.OWNER, AppRole.MANAGER)
  @Put(':branchId/special-hours/:date')
  @ApiOperation({
    summary: 'Create or replace a special operating hour (OWNER or assigned MANAGER)',
  })
  @ApiParam({ name: 'branchId', format: 'uuid' })
  @ApiParam({ name: 'date', example: '2026-09-02', description: 'YYYY-MM-DD' })
  @ApiOkResponse({ description: 'Special operating hour saved' })
  @ApiBadRequestResponse({ description: 'Invalid date or time pair' })
  upsertSpecialHour(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Param('date') date: string,
    @Body() dto: UpsertBranchSpecialHourDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.branchesService.upsertSpecialHour(branchId, date, dto, user);
  }

  @Roles(AppRole.OWNER, AppRole.MANAGER)
  @Delete(':branchId/special-hours/:date')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a special operating hour (OWNER or assigned MANAGER)',
  })
  @ApiParam({ name: 'branchId', format: 'uuid' })
  @ApiParam({ name: 'date', example: '2026-09-02', description: 'YYYY-MM-DD' })
  @ApiOkResponse({ description: 'Special operating hour deleted' })
  @ApiNotFoundResponse({ description: 'Branch or special operating hour not found' })
  deleteSpecialHour(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Param('date') date: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.branchesService.deleteSpecialHour(branchId, date, user);
  }

  @Get(':branchId/areas')
  @ApiOperation({
    summary: 'List branch areas filtered for the current role',
    description:
      'OWNER/MANAGER: all; WAITER: dining/pickup; KITCHEN: kitchen/bar; CASHIER: cashier/pickup.',
  })
  @ApiParam({ name: 'branchId', format: 'uuid' })
  @ApiOkResponse({ description: 'Role-visible branch areas' })
  listAreas(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.branchesService.listAreas(branchId, user);
  }

  @Roles(AppRole.OWNER, AppRole.MANAGER)
  @Post(':branchId/areas')
  @ApiOperation({ summary: 'Create a branch area (OWNER or assigned MANAGER)' })
  @ApiParam({ name: 'branchId', format: 'uuid' })
  @ApiCreatedResponse({ description: 'Branch area created' })
  @ApiConflictResponse({ description: 'Area code already exists in this branch' })
  createArea(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Body() dto: CreateBranchAreaDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.branchesService.createArea(branchId, dto, user);
  }

  @Roles(AppRole.OWNER, AppRole.MANAGER)
  @Patch(':branchId/areas/:areaId')
  @ApiOperation({ summary: 'Update a branch area (OWNER or assigned MANAGER)' })
  @ApiParam({ name: 'branchId', format: 'uuid' })
  @ApiParam({ name: 'areaId', format: 'uuid' })
  @ApiOkResponse({ description: 'Branch area updated' })
  @ApiConflictResponse({ description: 'Area code already exists in this branch' })
  updateArea(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Param('areaId', new ParseUUIDPipe()) areaId: string,
    @Body() dto: UpdateBranchAreaDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.branchesService.updateArea(branchId, areaId, dto, user);
  }

  @Roles(AppRole.OWNER, AppRole.MANAGER, AppRole.KITCHEN)
  @Patch(':branchId/areas/:areaId/status')
  @ApiOperation({
    summary: 'Change area status (OWNER, assigned MANAGER, or assigned KITCHEN for kitchen/bar)',
  })
  @ApiParam({ name: 'branchId', format: 'uuid' })
  @ApiParam({ name: 'areaId', format: 'uuid' })
  @ApiOkResponse({ description: 'Branch area status updated' })
  updateAreaStatus(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Param('areaId', new ParseUUIDPipe()) areaId: string,
    @Body() dto: UpdateBranchAreaStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.branchesService.updateAreaStatus(branchId, areaId, dto.status, user);
  }
}
