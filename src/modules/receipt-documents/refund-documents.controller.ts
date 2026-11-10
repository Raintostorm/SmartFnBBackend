import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProduces, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Response } from 'express';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RefundDocumentsService } from './refund-documents.service.js';

export class RefundSlipPrintDto {
  @ApiPropertyOptional({ minLength: 3, maxLength: 500, description: 'Required for a reprint (BR-53)' })
  @IsOptional() @IsString() @MinLength(3) @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({ default: true, description: 'false only for the first print right after the refund' })
  @IsOptional() @IsBoolean()
  isReprint?: boolean;
}

export class RefundSlipPrintResultDto {
  @ApiProperty({ enum: ['PRINTED', 'FAILED'] }) @IsIn(['PRINTED', 'FAILED']) status!: 'PRINTED' | 'FAILED';
  @ApiPropertyOptional({ maxLength: 500 }) @IsOptional() @IsString() @MaxLength(500) errorMessage?: string;
}

@ApiTags('Cashier refund documents')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@Roles(AppRole.OWNER, AppRole.MANAGER, AppRole.CASHIER)
@Controller('cashier/orders/:orderId/refunds/:refundId/document')
export class RefundDocumentsController {
  constructor(private readonly service: RefundDocumentsService) {}

  @Get()
  @ApiOperation({ summary: 'Refund slip PDF status and a download link (S3/R2: signed, 10 minutes). Never returns the storage key.' })
  @ApiOkResponse({ description: 'id, refundId, orderId, status (PENDING|READY|FAILED), fileName, fileSize, checksum, generatedAt, attempts, errorMessage, downloadUrl, expiresAt, printImageUrl' })
  get(@CurrentUser() user: AuthenticatedUser, @Param('orderId', new ParseUUIDPipe()) orderId: string, @Param('refundId', new ParseUUIDPipe()) refundId: string) {
    return this.service.get(user, orderId, refundId);
  }

  @Post('retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate the refund slip PDF again after a failure (never creates a second PDF or refund)' })
  retry(@CurrentUser() user: AuthenticatedUser, @Param('orderId', new ParseUUIDPipe()) orderId: string, @Param('refundId', new ParseUUIDPipe()) refundId: string) {
    return this.service.retry(user, orderId, refundId);
  }

  @Get('print-image')
  @ApiProduces('image/png')
  @ApiOperation({ summary: 'PNG (768 px wide, blank tail trimmed) rasterised from the stored refund PDF for 58 mm thermal printing' })
  async printImage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Param('refundId', new ParseUUIDPipe()) refundId: string,
    @Res() response: Response,
  ) {
    const { data } = await this.service.printImage(user, orderId, refundId);
    response.setHeader('Content-Type', 'image/png');
    response.setHeader('Cache-Control', 'private, no-store');
    response.send(data);
  }

  @Get('download')
  @ApiProduces('application/pdf')
  @ApiOperation({ summary: 'Download the stored refund slip PDF (used when storage is local)' })
  async download(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Param('refundId', new ParseUUIDPipe()) refundId: string,
    @Res() response: Response,
  ) {
    const file = await this.service.download(user, orderId, refundId);
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Content-Disposition', `inline; filename="${file.fileName.replace(/"/g, '')}"`);
    response.setHeader('Cache-Control', 'private, no-store');
    response.send(file.data);
  }

  @Post('prints')
  @ApiOperation({ summary: 'Record a print / reprint of the refund slip (reason ≥ 3 characters for reprints, BR-53)' })
  recordPrint(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Param('refundId', new ParseUUIDPipe()) refundId: string,
    @Body() dto: RefundSlipPrintDto,
  ) {
    return this.service.recordPrint(user, orderId, refundId, dto);
  }

  @Get('prints')
  @ApiOperation({ summary: 'Print and reprint history of the refund slip' })
  listPrints(@CurrentUser() user: AuthenticatedUser, @Param('orderId', new ParseUUIDPipe()) orderId: string, @Param('refundId', new ParseUUIDPipe()) refundId: string) {
    return this.service.listPrints(user, orderId, refundId);
  }
}

@ApiTags('Cashier refund documents')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@Roles(AppRole.OWNER, AppRole.MANAGER, AppRole.CASHIER)
@Controller('cashier/refund-print-logs')
export class RefundPrintLogsController {
  constructor(private readonly service: RefundDocumentsService) {}

  @Post(':printLogId/result')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Report the printer outcome of a refund slip print; never changes the refund' })
  result(@CurrentUser() user: AuthenticatedUser, @Param('printLogId', new ParseUUIDPipe()) id: string, @Body() dto: RefundSlipPrintResultDto) {
    return this.service.reportPrintResult(user, id, dto);
  }
}
