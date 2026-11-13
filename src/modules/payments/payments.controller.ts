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
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
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
  PaymentListQueryDto,
  PaymentListResponseDto,
  PaymentResponseDto,
  RefundListQueryDto,
} from './dto/payment.dto.js';
import { PaymentsService } from './payments.service.js';
import { PaidOrderRefundService } from './paid-order-refund.service.js';

@ApiTags('Payments')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiAuthenticatedOperation()
@Controller()
export class PaymentsController {
  constructor(
    private readonly service: PaymentsService,
    private readonly refunds: PaidOrderRefundService,
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

  @Roles(AppRole.MANAGER)
  @Post('payments/:paymentId/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Manually confirm a pending, mismatched or late-after-expiry bank transfer (MANAGER only)',
    description:
      'BM-05: receivedAmount must cover the expected amount. Confirmation, call number, ' +
      'preparation units, tracking link, print jobs and audit are committed together.',
  })
  @ApiUuidPath('paymentId', 'Bank-transfer payment requiring confirmation')
  @ApiOkResponse({ type: PaymentResponseDto })
  @ApiStandardMutationErrors({ notFound: 'Payment not found', conflict: 'Payment is not pending' })
  async confirm(
    @Param('paymentId', new ParseUUIDPipe()) paymentId: string,
    @Body() dto: ConfirmPaymentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.confirm(paymentId, dto, user);
  }

  @Roles(AppRole.OWNER, AppRole.MANAGER)
  @Get('refunds')
  @ApiOperation({ summary: 'List pending or historical refunds within the caller scope' })
  listRefunds(@Query() query: RefundListQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.refunds.listRefunds(user, query);
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
