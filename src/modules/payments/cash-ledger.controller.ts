import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import {
  CashLedgerDirection,
  CashLedgerSourceType,
  PaymentMethod,
} from '../../generated/prisma/client.js';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CashLedgerService } from './cash-ledger.service.js';

class LedgerRangeDto {
  @ApiPropertyOptional({ format: 'date-time' }) @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional({ format: 'date-time' }) @IsOptional() @IsDateString() to?: string;
  @ApiPropertyOptional({ enum: CashLedgerDirection })
  @IsOptional()
  @IsEnum(CashLedgerDirection)
  direction?: CashLedgerDirection;
  @ApiPropertyOptional({ enum: CashLedgerSourceType })
  @IsOptional()
  @IsEnum(CashLedgerSourceType)
  sourceType?: CashLedgerSourceType;
  @ApiPropertyOptional({ enum: PaymentMethod })
  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() cashierId?: string;
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 50;
}

@ApiTags('Cash ledger')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@Controller()
export class CashLedgerController {
  constructor(private readonly ledger: CashLedgerService) {}

  @Get('branches/:branchId/cash-ledger')
  @Roles(AppRole.OWNER, AppRole.MANAGER)
  @ApiOperation({ summary: 'Read the append-only sales and refund ledger of one branch' })
  branch(
    @CurrentUser() user: AuthenticatedUser,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: LedgerRangeDto,
  ) {
    return this.ledger.listBranch(user, branchId, query);
  }

  @Get('restaurant-chains/:chainId/cash-ledger')
  @Roles(AppRole.OWNER)
  @ApiOperation({ summary: 'Read the consolidated append-only ledger of an assigned chain' })
  chain(
    @CurrentUser() user: AuthenticatedUser,
    @Param('chainId', ParseUUIDPipe) chainId: string,
    @Query() query: LedgerRangeDto,
  ) {
    return this.ledger.listChain(user, chainId, query);
  }
}
