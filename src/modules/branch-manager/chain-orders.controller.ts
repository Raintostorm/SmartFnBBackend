import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { ApiAuthenticatedOperation } from '../../common/swagger/swagger.decorators.js';
import { ChainOrderQueryDto } from './manager.dto.js';
import { ManagerOperationsService } from './manager-operations.service.js';

/** GAP-310 (spec sections 15 and 28.6): the Brand Manager reads orders of the chains assigned to them. Read only. */
@Roles(AppRole.OWNER)
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiAuthenticatedOperation()
@ApiTags('Brand Manager - Orders')
@ApiNotFoundResponse({ description: 'The chain is not assigned to you, or the order/branch is not in it' })
@Controller('restaurant-chains/:chainId/orders')
export class ChainOrdersController {
  constructor(private readonly operations: ManagerOperationsService) {}

  @Get()
  @ApiOperation({
    summary: 'Search orders of an assigned chain by branch, date range, order code and status',
    description:
      'Same filters, pagination and item shape as GET /manager/orders, plus an optional branchId and the branch of each order. from is inclusive, to exclusive, based on placedAt.',
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Query() query: ChainOrderQueryDto,
  ) {
    return this.operations.chainOrders(user, chainId, query);
  }

  @Get(':orderId')
  @ApiOperation({
    summary: 'Order snapshots, creators, payment history and audit of one order in an assigned chain',
    description:
      'Same shape as GET /manager/orders/:orderId plus the branch. No PayOS credentials or raw webhook payloads are returned.',
  })
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ) {
    return this.operations.chainOrder(user, chainId, orderId);
  }
}
