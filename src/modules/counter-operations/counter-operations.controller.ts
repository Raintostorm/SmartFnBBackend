import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
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
import { RealtimePublisher } from '../../realtime/realtime.publisher.js';
import { CounterOperationsService } from './counter-operations.service.js';
import { CreatePayosPaymentDto } from '../payos/dto/payos-payment.dto.js';
import { PayosPaymentService } from '../payos/payos-payment.service.js';
import {
  AddCounterOrderItemDto,
  AvailabilityDto,
  CashPaymentDto,
  CancelCounterOrderDto,
  CheckoutCounterOrderDto,
  CreateCounterOrderDto,
  ReprintDto,
  StartPreparationBatchDto,
} from './dto/counter-operations.dto.js';

@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiAuthenticatedOperation()
@ApiTags('Cashier · Orders')
@Roles(AppRole.CASHIER)
@Controller('cashier')
export class CashierController {
  constructor(
    private readonly service: CounterOperationsService,
    private readonly realtime: RealtimePublisher,
    private readonly payosPayments: PayosPaymentService,
  ) {}

  @Get('context')
  @ApiOperation({ summary: 'Load branch menu, options, and availability for the counter POS' })
  context(@CurrentUser() user: AuthenticatedUser) {
    return this.service.cashierContext(user);
  }

  @Post('orders')
  @ApiOperation({ summary: 'Create an editable counter-order draft' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateCounterOrderDto) {
    return this.service.createDraft(user, dto);
  }

  @Post('checkout')
  @ApiOperation({
    summary: 'Validate a local cart and create one immutable order awaiting payment',
  })
  checkout(@CurrentUser() user: AuthenticatedUser, @Body() dto: CheckoutCounterOrderDto) {
    return this.service.checkout(user, dto);
  }

  @Get('orders')
  @ApiOperation({ summary: 'List today counter orders for the assigned branch' })
  history(@CurrentUser() user: AuthenticatedUser) {
    return this.service.cashierHistory(user);
  }

  @Get('orders/:orderId/receipt')
  @ApiOperation({ summary: 'Get immutable receipt and queue-ticket data for browser printing' })
  receipt(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.receipt(user, id);
  }

  @Post('orders/:orderId/reprint')
  @ApiOperation({ summary: 'Record and return an audited receipt and queue-ticket reprint' })
  reprint(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) id: string,
    @Body() dto: ReprintDto,
  ) {
    return this.service.reprint(user, id, dto.reason);
  }

  @Get('orders/:orderId')
  @ApiOperation({ summary: 'Get one counter order in the assigned branch' })
  @ApiUuidPath('orderId', 'Counter order')
  get(@CurrentUser() user: AuthenticatedUser, @Param('orderId', new ParseUUIDPipe()) id: string) {
    return this.service.getOrder(user, id);
  }

  @Post('orders/:orderId/items')
  @ApiOperation({ summary: 'Add a priced menu item and validated option snapshot to a draft' })
  @ApiStandardMutationErrors({
    conflict: 'Order is finalized, item is sold out, or an option is sold out',
  })
  async addItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) id: string,
    @Body() dto: AddCounterOrderItemDto,
  ) {
    const result = await this.service.addItem(user, id, dto);
    this.publish(user, 'cashier.order.updated', { orderId: id });
    return result;
  }

  @Delete('orders/:orderId/items/:itemId')
  @ApiOperation({ summary: 'Remove an item while the order remains editable' })
  async removeItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
  ) {
    const result = await this.service.removeItem(user, orderId, itemId);
    this.publish(user, 'cashier.order.updated', { orderId });
    return result;
  }

  @Patch('orders/:orderId/items/:itemId')
  @ApiOperation({ summary: 'Replace an item while the order remains editable' })
  async updateItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() dto: AddCounterOrderItemDto,
  ) {
    const result = await this.service.updateItem(user, orderId, itemId, dto);
    this.publish(user, 'cashier.order.updated', { orderId });
    return result;
  }

  @Post('orders/:orderId/finalize')
  @ApiOperation({ summary: 'Lock an order for payment' })
  finalize(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.finalize(user, id);
  }

  @Post('orders/:orderId/payments/cash')
  @ApiTags('Cashier · Payments')
  @ApiOperation({
    summary: 'Collect cash, assign a daily call number, and enqueue preparation atomically',
  })
  async cash(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) id: string,
    @Body() dto: CashPaymentDto,
  ) {
    const result = await this.service.collectCash(user, id, dto);
    this.publish(user, 'payment.confirmed', { orderId: id, callNumber: result.order.callNumber });
    this.publish(user, 'preparation.order.queued', {
      orderId: id,
      callNumber: result.order.callNumber,
    });
    return result;
  }

  @Post('orders/:orderId/payments/payos')
  @ApiTags('Cashier · Payments')
  @ApiOperation({ summary: 'Create or reuse a PayOS QR payment for a finalized order' })
  payos(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) id: string,
    @Body() dto: CreatePayosPaymentDto,
  ) {
    return this.payosPayments.create(user, id, dto);
  }

  @Post('orders/:orderId/cancel')
  @ApiOperation({ summary: 'Cancel an unpaid counter order before preparation begins' })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) id: string,
    @Body() dto: CancelCounterOrderDto,
  ) {
    return this.service.cancelUnpaid(user, id, dto.reason);
  }

  private publish(user: AuthenticatedUser, type: string, data: unknown) {
    if (user.branchId) this.realtime.branch(user.branchId, type, data);
  }
}

@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiAuthenticatedOperation()
@ApiTags('Barista · Queue')
@Roles(AppRole.BARISTA)
@Controller('barista')
export class BaristaController {
  constructor(
    private readonly service: CounterOperationsService,
    private readonly realtime: RealtimePublisher,
  ) {}

  @Get('context')
  @ApiOperation({ summary: 'Load branch menu and availability for the barista station' })
  context(@CurrentUser() user: AuthenticatedUser) {
    return this.service.baristaContext(user);
  }

  @Get('queue')
  @ApiOperation({ summary: 'List paid preparation units grouped into fair batches' })
  queue(@CurrentUser() user: AuthenticatedUser) {
    return this.service.baristaQueue(user);
  }

  @Get('ready-orders')
  @ApiOperation({ summary: 'List paid counter orders ready to hand to customers' })
  readyOrders(@CurrentUser() user: AuthenticatedUser) {
    return this.service.baristaReadyOrders(user);
  }

  @Post('batches/start')
  @ApiOperation({ summary: 'Atomically claim and start all units in one suggested batch' })
  async startBatch(@CurrentUser() user: AuthenticatedUser, @Body() dto: StartPreparationBatchDto) {
    const result = await this.service.startBatch(user, dto.unitIds);
    this.publish(user, 'preparation.batch.started', { unitIds: dto.unitIds });
    return result;
  }

  @Post('batches/complete')
  @ApiOperation({ summary: 'Complete all units in a batch claimed by the current barista' })
  async completeBatch(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: StartPreparationBatchDto,
  ) {
    const result = await this.service.completeBatch(user, dto.unitIds);
    this.publish(user, 'preparation.batch.completed', result);
    for (const order of result.readyOrders) {
      this.publishCallingDisplay(user, 'calling.order.ready', order);
    }
    return result;
  }

  @Post('units/:unitId/start')
  @ApiOperation({ summary: 'Start preparing one cup or portion' })
  async start(
    @CurrentUser() user: AuthenticatedUser,
    @Param('unitId', new ParseUUIDPipe()) id: string,
  ) {
    const result = await this.service.startUnit(user, id);
    this.publish(user, 'preparation.item.started', { unitId: id });
    return result;
  }

  @Post('units/:unitId/complete')
  @ApiOperation({ summary: 'Complete one cup or portion and recalculate order readiness' })
  async complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('unitId', new ParseUUIDPipe()) id: string,
  ) {
    const result = await this.service.completeUnit(user, id);
    this.publish(user, 'preparation.item.completed', { unitId: id });
    if (result.orderItem.order.status === 'READY') {
      this.publishCallingDisplay(user, 'calling.order.ready', {
        id: result.orderItem.order.id,
        orderCode: result.orderItem.order.orderCode,
        callNumber: result.orderItem.order.callNumber,
        readyAt: result.orderItem.order.readyAt,
      });
    }
    return result;
  }

  @Post('units/:unitId/undo')
  @ApiOperation({ summary: 'Undo a recent preparation status change by the current barista' })
  async undo(
    @CurrentUser() user: AuthenticatedUser,
    @Param('unitId', new ParseUUIDPipe()) id: string,
  ) {
    const result = await this.service.undoUnit(user, id);
    this.publish(user, 'preparation.item.undone', { unitId: id, status: result.status });
    return result;
  }

  @Post('orders/:orderId/deliver')
  @ApiOperation({ summary: 'Confirm that a ready order was handed to the customer' })
  async deliver(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) id: string,
  ) {
    const result = await this.service.deliverOrder(user, id);
    this.publish(user, 'preparation.order.delivered', { orderId: id });
    this.publishCallingDisplay(user, 'calling.order.delivered', {
      id: result.id,
      orderCode: result.orderCode,
      callNumber: result.callNumber,
    });
    return result;
  }

  @Patch('menu-items/:menuItemId/availability')
  @ApiTags('Barista · Availability')
  @ApiOperation({ summary: 'Mark a branch menu item available or sold out' })
  async itemAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Param('menuItemId', new ParseUUIDPipe()) id: string,
    @Body() dto: AvailabilityDto,
  ) {
    const result = await this.service.setMenuItemAvailability(user, id, dto);
    this.publish(user, 'menu.availability.changed', result);
    if (result.affectedOrderIds.length) {
      this.publish(user, 'manager.order.attention-required', {
        reason: 'ITEM_OUT_OF_STOCK',
        menuItemId: id,
        orderIds: result.affectedOrderIds,
      });
    }
    return result;
  }

  @Patch('menu-options/:optionId/availability')
  @ApiTags('Barista · Availability')
  @ApiOperation({ summary: 'Mark a branch menu option available or sold out' })
  async optionAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Param('optionId', new ParseUUIDPipe()) id: string,
    @Body() dto: AvailabilityDto,
  ) {
    const result = await this.service.setOptionAvailability(user, id, dto);
    this.publish(user, 'menu.availability.changed', result);
    if (result.affectedOrderIds.length) {
      this.publish(user, 'manager.order.attention-required', {
        reason: 'OPTION_OUT_OF_STOCK',
        optionId: id,
        orderIds: result.affectedOrderIds,
      });
    }
    return result;
  }

  private publish(user: AuthenticatedUser, type: string, data: unknown) {
    if (user.branchId) this.realtime.branch(user.branchId, type, data);
  }

  private publishCallingDisplay(user: AuthenticatedUser, type: string, data: unknown) {
    if (user.branchId) this.realtime.callingDisplay(user.branchId, type, data);
  }
}
