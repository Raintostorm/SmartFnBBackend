import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import {
  AddOrderItemDto,
  CreateOrderDto,
  PaginationDto,
  UnavailableItemDto,
} from './dto/order-operations.dto.js';
import { OrdersService } from './orders.service.js';

@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiTags('Waiter orders')
@Roles(AppRole.WAITER)
@Controller('waiter/orders')
export class WaiterOrdersController {
  constructor(private readonly service: OrdersService) {}
  @Post()
  @ApiOperation({ summary: 'Create a draft order for an open table session' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOrderDto) {
    return this.service.createOrder(user, dto);
  }
  @Get(':orderId')
  @ApiOperation({ summary: 'View an order in the waiter branch' })
  get(@CurrentUser() user: AuthenticatedUser, @Param('orderId', new ParseUUIDPipe()) id: string) {
    return this.service.getOrder(user, id);
  }
  @Post(':orderId/items')
  @ApiOperation({ summary: 'Add an item to a draft order' })
  addItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) id: string,
    @Body() dto: AddOrderItemDto,
  ) {
    return this.service.addItem(user, id, dto);
  }
  @Post(':orderId/submit')
  @ApiOperation({ summary: 'Submit all draft items to the kitchen queue' })
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.submit(user, id);
  }
}

@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiTags('Kitchen operations')
@Roles(AppRole.KITCHEN)
@Controller('kitchen')
export class KitchenController {
  constructor(private readonly service: OrdersService) {}
  @Get('queue')
  @ApiOperation({ summary: 'List queued and preparing items in the kitchen branch' })
  queue(@CurrentUser() user: AuthenticatedUser, @Query() query: PaginationDto) {
    return this.service.kitchenQueue(user, query);
  }
  @Post('items/:itemId/start')
  @ApiOperation({ summary: 'Atomically claim and start preparing a queued item' })
  start(@CurrentUser() user: AuthenticatedUser, @Param('itemId', new ParseUUIDPipe()) id: string) {
    return this.service.startItem(user, id);
  }
  @Post('items/:itemId/ready')
  @ApiOperation({ summary: 'Mark a preparing item ready and create a serving task' })
  ready(@CurrentUser() user: AuthenticatedUser, @Param('itemId', new ParseUUIDPipe()) id: string) {
    return this.service.readyItem(user, id);
  }
  @Post('items/:itemId/unavailable')
  @ApiOperation({ summary: 'Mark a queued or preparing item unavailable' })
  unavailable(
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId', new ParseUUIDPipe()) id: string,
    @Body() dto: UnavailableItemDto,
  ) {
    return this.service.unavailableItem(user, id, dto.reason);
  }
}

@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiTags('Waiter serving')
@Roles(AppRole.WAITER)
@Controller('waiter/serving-tasks')
export class ServingTasksController {
  constructor(private readonly service: OrdersService) {}
  @Get()
  @ApiOperation({ summary: 'List ready items available to serve' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: PaginationDto) {
    return this.service.servingQueue(user, query);
  }
  @Post(':taskId/claim')
  @ApiOperation({ summary: 'Atomically claim a serving task' })
  claim(@CurrentUser() user: AuthenticatedUser, @Param('taskId', new ParseUUIDPipe()) id: string) {
    return this.service.claimTask(user, id);
  }
  @Post(':taskId/serve')
  @ApiOperation({ summary: 'Confirm that the claimed item was served' })
  serve(@CurrentUser() user: AuthenticatedUser, @Param('taskId', new ParseUUIDPipe()) id: string) {
    return this.service.serveTask(user, id);
  }
}
