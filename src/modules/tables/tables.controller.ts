import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiAuthenticatedOperation,
  ApiStandardMutationErrors,
  ApiUuidPath,
} from '../../common/swagger/swagger.decorators.js';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import {
  CreateTableDto,
  ReplaceBranchTableAdjacencyDto,
  TableResponseDto,
  UpdateTableDto,
  UpdateTableStatusDto,
} from './dto/table.dto.js';
import { TablesService } from './tables.service.js';
import { RealtimePublisher } from '../../realtime/realtime.publisher.js';

@ApiTags('Tables')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiAuthenticatedOperation()
@Roles(AppRole.OWNER, AppRole.MANAGER, AppRole.WAITER)
@Controller()
export class TablesController {
  constructor(
    private readonly service: TablesService,
    private readonly realtime: RealtimePublisher,
  ) {}

  @Get('branches/:branchId/tables')
  @ApiOperation({
    summary: 'List the branch floor plan and current table states',
    description: 'Returns active physical tables with their symmetric adjacency identifiers.',
  })
  @ApiUuidPath('branchId', 'Branch whose tables are requested')
  @ApiOkResponse({ type: TableResponseDto, isArray: true })
  list(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.list(branchId, user);
  }

  @Roles(AppRole.OWNER, AppRole.MANAGER)
  @Post('branches/:branchId/tables')
  @ApiOperation({
    summary: 'Create a physical table in a branch',
    description: 'The table code must be unique inside the branch.',
  })
  @ApiCreatedResponse({ type: TableResponseDto })
  async create(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Body() dto: CreateTableDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.service.create(branchId, dto, user);
    this.realtime.branch(branchId, 'table.created', { id: result.id, status: result.status });
    return result;
  }

  @Roles(AppRole.OWNER, AppRole.MANAGER)
  @Patch('tables/:tableId')
  @ApiOperation({
    summary: 'Update a physical table',
    description: 'Updates table identity, capacity, floor, or floor-plan coordinates.',
  })
  @ApiOkResponse({ type: TableResponseDto })
  @ApiStandardMutationErrors({ notFound: 'Table not found', conflict: 'Table code already exists' })
  async update(
    @Param('tableId', new ParseUUIDPipe()) tableId: string,
    @Body() dto: UpdateTableDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.service.update(tableId, dto, user);
    this.realtime.branch(result.branchId, 'table.updated', {
      id: result.id,
      status: result.status,
    });
    return result;
  }

  @Roles(AppRole.OWNER, AppRole.MANAGER)
  @Patch('tables/:tableId/status')
  @ApiOperation({
    summary: 'Change a physical table status',
    description: 'A table in an open serving session cannot be changed back to AVAILABLE.',
  })
  @ApiOkResponse({ type: TableResponseDto })
  async updateStatus(
    @Param('tableId', new ParseUUIDPipe()) tableId: string,
    @Body() dto: UpdateTableStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.service.updateStatus(tableId, dto.status, user);
    this.realtime.branch(result.branchId, 'table.status-updated', {
      id: result.id,
      status: result.status,
    });
    return result;
  }

  @Roles(AppRole.OWNER, AppRole.MANAGER)
  @Put('branches/:branchId/table-adjacency')
  @ApiOperation({
    summary: 'Replace the symmetric adjacency set for one table',
    description:
      'Every adjacency is stored in both directions and all referenced tables must belong to this branch.',
  })
  @ApiOkResponse({ type: TableResponseDto, isArray: true })
  async replaceAdjacency(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Body() dto: ReplaceBranchTableAdjacencyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.service.replaceAdjacency(branchId, dto.tableId, dto, user);
    this.realtime.branch(branchId, 'table.adjacency-updated', { tableId: dto.tableId });
    return result;
  }
}
