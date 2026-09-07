import { Body, Controller, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AccountStatusResponseDto } from './dto/account-status-response.dto.js';
import { UpdateAccountStatusDto } from './dto/update-account-status.dto.js';
import type { AccountStatusView } from './users.service.js';
import { UsersService } from './users.service.js';

@Roles(AppRole.ADMIN)
@ApiTags('Users')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Patch(':userId/status')
  @ApiOperation({ summary: 'Change the status of another user account' })
  @ApiParam({ name: 'userId', format: 'uuid', description: 'Target user ID' })
  @ApiOkResponse({ type: AccountStatusResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid status, user ID, or attempt to change own status',
  })
  @ApiUnauthorizedResponse({ description: 'Access token is missing, invalid, or expired' })
  @ApiForbiddenResponse({ description: 'Only ADMIN can change account status' })
  @ApiNotFoundResponse({ description: 'User not found' })
  updateAccountStatus(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() dto: UpdateAccountStatusDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<AccountStatusView> {
    return this.usersService.updateAccountStatus(currentUser.id, userId, dto.status);
  }
}
