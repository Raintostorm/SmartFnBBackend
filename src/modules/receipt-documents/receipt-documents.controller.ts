import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { ReceiptDocumentsService } from './receipt-documents.service.js';

@ApiTags('Cashier receipt documents')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@Roles(AppRole.OWNER, AppRole.MANAGER, AppRole.CASHIER)
@Controller('cashier/orders/:orderId/receipt-document')
export class ReceiptDocumentsController {
  constructor(private readonly service: ReceiptDocumentsService) {}

  @Get()
  @ApiOperation({ summary: 'Get the immutable PDF receipt status and temporary download URL' })
  @ApiOkResponse({ description: 'Receipt PDF metadata' })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ) {
    return this.service.get(user, orderId);
  }

  @Post('retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry a failed receipt PDF generation' })
  retry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ) {
    return this.service.retry(user, orderId);
  }

  @Get('download')
  @ApiProduces('application/pdf')
  @ApiOperation({ summary: 'Download a locally stored receipt PDF' })
  async download(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Res() response: Response,
  ) {
    const file = await this.service.download(user, orderId);
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader(
      'Content-Disposition',
      `inline; filename="${file.fileName.replace(/"/g, '')}"`,
    );
    response.setHeader('Cache-Control', 'private, no-store');
    response.send(file.data);
  }
}
