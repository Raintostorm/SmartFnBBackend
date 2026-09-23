import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiAuthenticatedOperation,
  ApiPaginatedResponse,
  ApiStandardMutationErrors,
  ApiUuidPath,
} from '../../common/swagger/swagger.decorators.js';
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
import {
  KitchenQueueItemResponseDto,
  OrderItemResponseDto,
  OrderResponseDto,
  ServingTaskResponseDto,
  WaiterContextResponseDto,
} from './dto/order-responses.dto.js';
import { OrdersService } from './orders.service.js';
import { RealtimePublisher } from '../../realtime/realtime.publisher.js';

@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiTags('Waiter · Orders')
@ApiAuthenticatedOperation()
@Roles(AppRole.WAITER)
@Controller('waiter/orders')
export class WaiterOrdersController {
  constructor(
    private readonly service: OrdersService,
    private readonly realtime: RealtimePublisher,
  ) {}
  @Get('context/current')
  @ApiOperation({
    summary: 'Load the Waiter workspace',
    description:
      'Returns one branch-scoped snapshot containing active tables, open sessions, sellable menu entries, orders, and the current work session.',
  })
  @ApiOkResponse({ type: WaiterContextResponseDto })
  context(@CurrentUser() user: AuthenticatedUser) {
    return this.service.waiterContext(user);
  }
  @Post()
  @ApiOperation({
    summary: 'Create a draft order',
    description:
      'Precondition: the table session belongs to the Waiter branch and is OPEN or SERVING. The new order starts in PENDING.',
  })
  @ApiCreatedResponse({ type: OrderResponseDto })
  @ApiStandardMutationErrors({ notFound: 'Open table session was not found in the current branch' })
  async create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOrderDto) {
    const result = await this.service.createOrder(user, dto);
    this.publish(user, 'order.created', { id: result.id, status: result.status });
    return result;
  }
  @Get(':orderId')
  @ApiOperation({
    summary: 'View an order in the waiter branch',
    description:
      'Returns the order, its table session, and item details only when it belongs to the authenticated Waiter branch.',
  })
  @ApiUuidPath('orderId', 'Order to retrieve')
  @ApiOkResponse({ type: OrderResponseDto })
  @ApiStandardMutationErrors({ notFound: 'Order was not found in the current branch' })
  get(@CurrentUser() user: AuthenticatedUser, @Param('orderId', new ParseUUIDPipe()) id: string) {
    return this.service.getOrder(user, id);
  }
  @Post(':orderId/items')
  @ApiOperation({
    summary: 'Add an item to a draft order',
    description:
      'Allowed only while the order is PENDING. Availability and remaining portions are checked for the current branch.',
  })
  @ApiUuidPath('orderId', 'Draft order receiving the item')
  @ApiCreatedResponse({ type: OrderItemResponseDto })
  @ApiStandardMutationErrors({
    notFound: 'Order was not found in the current branch',
    conflict: 'Order was submitted, item is unavailable, or remaining portions are insufficient',
  })
  async addItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) id: string,
    @Body() dto: AddOrderItemDto,
  ) {
    const result = await this.service.addItem(user, id, dto);
    this.publish(user, 'order.item-added', { id: result.id, orderId: result.orderId });
    return result;
  }
  @Post(':orderId/submit')
  @ApiOperation({
    summary: 'Submit an order to Kitchen Staff',
    description:
      'Transition: Order PENDING → SUBMITTED and every item PENDING → QUEUED. Limited portions are reserved atomically; the whole transaction rolls back on failure.',
  })
  @ApiUuidPath('orderId', 'Draft order to submit')
  @ApiCreatedResponse({ type: OrderResponseDto })
  @ApiStandardMutationErrors({
    notFound: 'Order was not found in the current branch',
    conflict: 'Order was already submitted or portions changed concurrently',
  })
  async submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) id: string,
  ) {
    const result = await this.service.submit(user, id);
    this.publish(user, 'order.submitted', { id: result.id, status: result.status });
    return result;
  }

  private publish(user: AuthenticatedUser, type: string, data: unknown) {
    if (user.branchId) this.realtime.branch(user.branchId, type, data);
  }
}

@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiTags('Kitchen · Queue')
@ApiAuthenticatedOperation()
@Roles(AppRole.KITCHEN)
@Controller('kitchen')
export class KitchenController {
  constructor(
    private readonly service: OrdersService,
    private readonly realtime: RealtimePublisher,
  ) {}
  @Get('queue')
  @ApiOperation({
    summary: 'List the Kitchen queue',
    description:
      'Returns QUEUED and PREPARING items for the authenticated Kitchen Staff branch, oldest first.',
  })
  @ApiPaginatedResponse(KitchenQueueItemResponseDto, 'Paginated Kitchen queue')
  queue(@CurrentUser() user: AuthenticatedUser, @Query() query: PaginationDto) {
    return this.service.kitchenQueue(user, query);
  }
  @Post('items/:itemId/start')
  @ApiOperation({
    summary: 'Start preparing an item',
    description:
      'Atomic transition: QUEUED → PREPARING. A conditional update prevents two Kitchen Staff members from starting the same item.',
  })
  @ApiUuidPath('itemId', 'Queued order item')
  @ApiCreatedResponse({ type: OrderItemResponseDto })
  @ApiStandardMutationErrors({
    notFound: 'Order item was not found in the current branch',
    conflict: 'Item is no longer QUEUED or was updated concurrently',
  })
  async start(
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId', new ParseUUIDPipe()) id: string,
  ) {
    const result = await this.service.startItem(user, id);
    this.publish(user, 'kitchen.item-started', { id: result.id, status: result.status });
    return result;
  }
  @Post('items/:itemId/ready')
  @ApiOperation({
    summary: 'Mark an item ready',
    description:
      'Atomic transition: PREPARING → READY. Exactly one WAITING serving task is created in the same transaction.',
  })
  @ApiUuidPath('itemId', 'Preparing order item')
  @ApiCreatedResponse({ type: OrderItemResponseDto })
  @ApiStandardMutationErrors({
    notFound: 'Order item was not found in the current branch',
    conflict: 'Item is no longer PREPARING or was updated concurrently',
  })
  async ready(
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId', new ParseUUIDPipe()) id: string,
  ) {
    const result = await this.service.readyItem(user, id);
    this.publish(user, 'kitchen.item-ready', { id: result.id, status: result.status });
    return result;
  }
  @Post('items/:itemId/unavailable')
  @ApiOperation({
    summary: 'Report an unavailable item',
    description:
      'Transition: QUEUED or PREPARING → OUT_OF_STOCK. The reason and Kitchen Staff identity are audited.',
  })
  @ApiUuidPath('itemId', 'Queued or preparing order item')
  @ApiCreatedResponse({ type: OrderItemResponseDto })
  @ApiStandardMutationErrors({
    notFound: 'Order item was not found in the current branch',
    conflict: 'Item can no longer be marked unavailable',
  })
  async unavailable(
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId', new ParseUUIDPipe()) id: string,
    @Body() dto: UnavailableItemDto,
  ) {
    const result = await this.service.unavailableItem(user, id, dto.reason);
    this.publish(user, 'kitchen.item-unavailable', { id: result.id, status: result.status });
    return result;
  }

  private publish(user: AuthenticatedUser, type: string, data: unknown) {
    if (user.branchId) this.realtime.branch(user.branchId, type, data);
  }
}

@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiTags('Waiter · Serving')
@ApiAuthenticatedOperation()
@Roles(AppRole.WAITER)
@Controller('waiter/serving-tasks')
export class ServingTasksController {
  constructor(
    private readonly service: OrdersService,
    private readonly realtime: RealtimePublisher,
  ) {}
  @Get()
  @ApiOperation({
    summary: 'List serving tasks',
    description:
      'Shows WAITING tasks, tasks claimed by the current Waiter, and expired claims eligible for recovery.',
  })
  @ApiPaginatedResponse(ServingTaskResponseDto, 'Paginated ready-item serving queue')
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: PaginationDto) {
    return this.service.servingQueue(user, query);
  }
  @Post(':taskId/claim')
  @ApiOperation({
    summary: 'Claim a serving task',
    description:
      'Atomic transition: WAITING → CLAIMED. An expired claim may be recovered after SERVING_TASK_CLAIM_TIMEOUT_SECONDS.',
  })
  @ApiUuidPath('taskId', 'Serving task to claim')
  @ApiCreatedResponse({ type: ServingTaskResponseDto })
  @ApiStandardMutationErrors({
    conflict: 'Task is unavailable, already claimed, or the previous claim has not expired',
  })
  async claim(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taskId', new ParseUUIDPipe()) id: string,
  ) {
    const result = await this.service.claimTask(user, id);
    this.publish(user, 'serving-task.claimed', { id: result.id, status: result.status });
    return result;
  }
  @Post(':taskId/serve')
  @ApiOperation({
    summary: 'Confirm item service',
    description:
      'Transitions the current Waiter claim CLAIMED → SERVED and the order item READY → SERVED in one transaction.',
  })
  @ApiUuidPath('taskId', 'Claimed serving task')
  @ApiCreatedResponse({ type: ServingTaskResponseDto })
  @ApiStandardMutationErrors({
    notFound: 'Serving task was not found in the current branch',
    conflict: 'Task is not claimed by the current Waiter',
  })
  async serve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taskId', new ParseUUIDPipe()) id: string,
  ) {
    const result = await this.service.serveTask(user, id);
    this.publish(user, 'serving-task.served', { id: result.id, status: result.status });
    return result;
  }

  private publish(user: AuthenticatedUser, type: string, data: unknown) {
    if (user.branchId) this.realtime.branch(user.branchId, type, data);
  }
}
