import { Body, Controller, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsInt, Max, Min, ValidateIf } from 'class-validator';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PagersService } from './pagers.service.js';
export class AssignPagerDto {
  @ApiProperty({ nullable: true, minimum: 1, maximum: 999, description: 'null removes the pager' })
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(999)
  pagerNumber!: number | null;
}
export class NotifyPagerDto {
  @ApiProperty({ minimum: 1, maximum: 999 })
  @IsInt()
  @Min(1)
  @Max(999)
  pagerNumber!: number;
}
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiTags('Counter · Pagers')
@Controller('counter/orders')
export class PagersController {
  constructor(private readonly service: PagersService) {}
  @Patch(':orderId/pager')
  @Roles(AppRole.CASHIER, AppRole.MANAGER)
  @ApiOperation({ summary: 'Assign, replace or remove a physical pager on a paid open order' })
  assign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) id: string,
    @Body() dto: AssignPagerDto,
  ) {
    return this.service.change(user, id, dto.pagerNumber);
  }
  @Post(':orderId/pager/notify')
  @Roles(AppRole.BARISTA, AppRole.MANAGER)
  @ApiOperation({
    summary: 'Record that staff manually called the physical pager; no hardware signal is sent',
  })
  notify(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) id: string,
    @Body() dto: NotifyPagerDto,
  ) {
    return this.service.change(user, id, dto.pagerNumber, true);
  }
}
