import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
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
  ConfirmPaymentDto,
  CreateTableSessionPaymentDto,
  PaymentListQueryDto,
  PaymentListResponseDto,
  PaymentResponseDto,
} from './dto/payment.dto.js';
import { PaymentsService } from './payments.service.js';
import { RealtimePublisher } from '../../realtime/realtime.publisher.js';

@ApiTags('Payments')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiAuthenticatedOperation()
@Controller()
export class PaymentsController {
  constructor(
    private readonly service: PaymentsService,
    private readonly realtime: RealtimePublisher,
  ) {}

  @Roles(AppRole.OWNER, AppRole.MANAGER, AppRole.CASHIER)
  @Get('branches/:branchId/payments')
  @ApiOperation({
    summary: 'List and filter payment history for a branch',
    description:
      'Supports status, date-range, and pagination filters within the caller branch scope.',
  })
  @ApiUuidPath('branchId', 'Branch whose payments are requested')
  @ApiOkResponse({ type: PaymentListResponseDto })
  list(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Query() query: PaymentListQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.list(branchId, query, user);
  }

  @Roles(AppRole.MANAGER, AppRole.CASHIER)
  @Post('table-sessions/:tableSessionId/payments')
  @ApiOperation({
    summary: 'Create a pending payment for a table session',
    description:
      'Validates the open session and remaining balance before recording a pending payment.',
  })
  @ApiUuidPath('tableSessionId', 'Open table session to pay')
  @ApiCreatedResponse({ type: PaymentResponseDto })
  @ApiStandardMutationErrors({
    notFound: 'Open table session not found',
    conflict: 'Session already paid',
  })
  async createForTableSession(
    @Param('tableSessionId', new ParseUUIDPipe()) tableSessionId: string,
    @Body() dto: CreateTableSessionPaymentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.service.createForTableSession(tableSessionId, dto, user);
    const branchId = result.tableSession?.branchId ?? result.order?.branchId;
    if (branchId)
      this.realtime.branch(branchId, 'payment.created', { id: result.id, status: result.status });
    return result;
  }

  @Roles(AppRole.MANAGER, AppRole.CASHIER)
  @Post('payments/:paymentId/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm a pending payment and synchronize paid states',
    description:
      'Atomically records the processor and synchronizes the payment state of the session and its orders.',
  })
  @ApiUuidPath('paymentId', 'Pending payment to confirm')
  @ApiOkResponse({ type: PaymentResponseDto })
  @ApiStandardMutationErrors({ notFound: 'Payment not found', conflict: 'Payment is not pending' })
  async confirm(
    @Param('paymentId', new ParseUUIDPipe()) paymentId: string,
    @Body() dto: ConfirmPaymentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.service.confirm(paymentId, dto, user);
    const branchId = result.tableSession?.branchId ?? result.order?.branchId;
    if (branchId)
      this.realtime.branch(branchId, 'payment.confirmed', { id: result.id, status: result.status });
    return result;
  }

  @Roles(AppRole.OWNER, AppRole.MANAGER, AppRole.CASHIER)
  @Get('payments/:paymentId')
  @ApiOperation({
    summary: 'Get payment details within the current user scope',
    description: 'Returns the linked session or order and the employee who processed the payment.',
  })
  @ApiUuidPath('paymentId', 'Payment to retrieve')
  @ApiOkResponse({ type: PaymentResponseDto })
  get(
    @Param('paymentId', new ParseUUIDPipe()) paymentId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.get(paymentId, user);
  }
}
