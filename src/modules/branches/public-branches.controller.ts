import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator.js';
import { BranchesService } from './branches.service.js';
import { ListPublicBranchesQueryDto } from './dto/branch.dto.js';

@Public()
@ApiTags('Restaurant chains - public')
@Controller('public')
export class PublicBranchesController {
  constructor(private readonly branchesService: BranchesService) {}

  @Get('restaurant-chains')
  @ApiOperation({ summary: 'List active restaurant chains (public)' })
  @ApiOkResponse({ description: 'Active restaurant chains' })
  listChains() {
    return this.branchesService.listPublicChains();
  }

  @Get('branches')
  @ApiOperation({ summary: 'List active branches of active chains (public)' })
  @ApiOkResponse({ description: 'Active branches and weekly operating hours' })
  listBranches(@Query() query: ListPublicBranchesQueryDto) {
    return this.branchesService.listPublicBranches(query);
  }

  @Get('branches/:branchId')
  @ApiOperation({
    summary: 'Get an active branch, hours, and public-visible areas',
  })
  @ApiParam({ name: 'branchId', format: 'uuid' })
  @ApiOkResponse({ description: 'Public branch detail' })
  @ApiNotFoundResponse({ description: 'Active branch not found' })
  getBranch(@Param('branchId', new ParseUUIDPipe()) branchId: string) {
    return this.branchesService.getPublicBranch(branchId);
  }
}
