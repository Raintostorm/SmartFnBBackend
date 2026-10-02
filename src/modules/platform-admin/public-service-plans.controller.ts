import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator.js';
import { PlatformAdminService } from './platform-admin.service.js';

class PublicServicePlanResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'STARTER' })
  code!: string;

  @ApiProperty({ example: 'Starter' })
  name!: string;

  @ApiProperty({ example: 'Gói dành cho chuỗi nhà hàng mới', nullable: true })
  description!: string | null;

  @ApiProperty({ example: '299000.00', description: 'Monthly price as a decimal string' })
  monthlyPrice!: string;

  @ApiProperty({ example: 3 })
  maxBranches!: number;

  @ApiProperty({ example: 20 })
  maxAccounts!: number;

  @ApiProperty({ example: 100 })
  maxTables!: number;

  @ApiProperty({ example: true })
  brandingEnabled!: boolean;

  @ApiProperty({ example: false })
  multiBranchComparisonEnabled!: boolean;
}

@Public()
@ApiTags('Service plans - public')
@Controller('public/service-plans')
export class PublicServicePlansController {
  constructor(private readonly platformAdminService: PlatformAdminService) {}

  @Get()
  @ApiOperation({ summary: 'List active service plans for prospective Owners' })
  @ApiOkResponse({ type: PublicServicePlanResponseDto, isArray: true })
  listActivePlans() {
    return this.platformAdminService.listPublicServicePlans();
  }
}
