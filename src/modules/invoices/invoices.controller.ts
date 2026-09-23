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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CancelInvoiceDto, InvoiceListQueryDto, IssueInvoiceDto } from './dto/invoice.dto.js';
import { InvoicesService } from './invoices.service.js';
import { RealtimePublisher } from '../../realtime/realtime.publisher.js';

@ApiTags('Invoices and bill printing')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@Controller()
export class InvoicesController {
  constructor(
    private readonly service: InvoicesService,
    private readonly realtime: RealtimePublisher,
  ) {}

  @Roles(AppRole.MANAGER, AppRole.WAITER, AppRole.CASHIER)
  @Get('table-sessions/:tableSessionId/bill-preview')
  @ApiOperation({ summary: 'View the current table-session bill before payment' })
  preview(
    @Param('tableSessionId', new ParseUUIDPipe()) tableSessionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.preview(tableSessionId, user);
  }

  @Roles(AppRole.MANAGER, AppRole.CASHIER)
  @Post('table-sessions/:tableSessionId/invoices')
  @ApiOperation({
    summary: 'Issue an immutable internal sales invoice after full payment',
    description: 'Idempotent: returns the existing issued invoice when called again.',
  })
  async issue(
    @Param('tableSessionId', new ParseUUIDPipe()) tableSessionId: string,
    @Body() dto: IssueInvoiceDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.service.issue(tableSessionId, dto, user);
    this.realtime.branch(result.branchId, 'invoice.issued', {
      id: result.id,
      tableSessionId: result.tableSessionId,
      status: result.status,
    });
    return result;
  }

  @Roles(AppRole.OWNER, AppRole.MANAGER, AppRole.CASHIER)
  @Get('branches/:branchId/invoices')
  @ApiOperation({ summary: 'List invoices in a branch' })
  list(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Query() query: InvoiceListQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.list(branchId, query, user);
  }

  @Roles(AppRole.OWNER, AppRole.MANAGER, AppRole.CASHIER)
  @Get('invoices/:invoiceId')
  @ApiOperation({ summary: 'Get the immutable invoice snapshot' })
  get(
    @Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.get(invoiceId, user);
  }

  @Roles(AppRole.OWNER, AppRole.MANAGER, AppRole.CASHIER)
  @Get('invoices/:invoiceId/print')
  @ApiOperation({ summary: 'Get the browser-printable invoice payload' })
  print(
    @Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.get(invoiceId, user);
  }

  @Roles(AppRole.MANAGER, AppRole.CASHIER)
  @Post('invoices/:invoiceId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an issued invoice while preserving its snapshot' })
  async cancel(
    @Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
    @Body() dto: CancelInvoiceDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.service.cancel(invoiceId, dto, user);
    this.realtime.branch(result.branchId, 'invoice.cancelled', {
      id: result.id,
      status: result.status,
    });
    return result;
  }
}
