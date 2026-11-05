import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PaidOrderRefundService } from './paid-order-refund.service.js';
export const refundReasonCodes = [
  'CHANGE_OF_MIND',
  'WRONG_ITEM',
  'OUT_OF_STOCK',
  'LONG_WAIT',
  'OTHER',
] as const;
class RefundLineDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() orderItemId!: string;
}
export class CashierRefundDto {
  @ApiPropertyOptional({
    type: [RefundLineDto],
    description: 'Empty or omitted means all remaining lines',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique((item: RefundLineDto) => item.orderItemId)
  @ValidateNested({ each: true })
  @Type(() => RefundLineDto)
  items?: RefundLineDto[];
  @ApiProperty({ enum: refundReasonCodes }) @IsIn(refundReasonCodes) reasonCode!: string;
  @ApiPropertyOptional({ maxLength: 500 }) @IsOptional() @IsString() @MaxLength(450) note?: string;
}
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiTags('Cashier · Cash refunds')
@Roles(AppRole.CASHIER)
@Controller('cashier/orders')
export class CashierRefundsController {
  constructor(private readonly refunds: PaidOrderRefundService) {}
  @Post(':orderId/refunds')
  @ApiOperation({
    summary: 'Confirm cash handed back to the customer; paid today, own branch only',
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) id: string,
    @Body() dto: CashierRefundDto,
  ) {
    return this.refunds.cashierRefund(user, id, dto);
  }
  @Post(':orderId/refund-approval-requests')
  @ApiOperation({ summary: 'Request Store Manager approval for a prior-day cash refund' })
  requestApproval(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) id: string,
    @Body() dto: CashierRefundDto,
  ) {
    return this.refunds.requestRefundApproval(user, id, dto);
  }
  @Get(':orderId/refunds/:refundId/receipt')
  @ApiOperation({ summary: 'Get the immutable refund values for a cash refund receipt' })
  receipt(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) id: string,
    @Param('refundId', ParseUUIDPipe) refundId: string,
  ) {
    return this.refunds.refundReceipt(user, id, refundId);
  }
}

@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiTags('Cashier · Refund approvals')
@Roles(AppRole.CASHIER)
@Controller('cashier/refund-approval-requests')
export class CashierRefundApprovalsController {
  constructor(private readonly refunds: PaidOrderRefundService) {}

  @Get()
  @ApiOperation({ summary: 'List your prior-day refund requests' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.refunds.listRefundApprovalRequests(user);
  }

  @Post(':requestId/complete')
  @ApiOperation({ summary: 'Confirm cash paid to the customer after Store Manager approval' })
  complete(@CurrentUser() user: AuthenticatedUser, @Param('requestId', ParseUUIDPipe) requestId: string) {
    return this.refunds.completeApprovedRefund(user, requestId);
  }
}
