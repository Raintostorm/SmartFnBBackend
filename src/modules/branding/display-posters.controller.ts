import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import {
  DisplayPostersService,
  POSTER_MAX_BYTES,
  type PosterFile,
} from './display-posters.service.js';
import { DisplayPosterResponseDto, UpdateDisplayPosterDto } from './dto/display-poster.dto.js';

@ApiTags('Owner display posters')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@Roles(AppRole.OWNER)
@Controller('restaurant-chains/:chainId/display-posters')
export class DisplayPostersController {
  constructor(private readonly service: DisplayPostersService) {}

  @Get()
  @ApiOperation({
    summary: 'OWNER: list chain posters including disabled ones, in slideshow order',
  })
  @ApiOkResponse({ type: DisplayPosterResponseDto, isArray: true })
  list(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.list(chainId, user);
  }

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { files: 1, fileSize: POSTER_MAX_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'JPEG/PNG/WebP, max 5 MB. Maximum 10 posters per chain.',
        },
      },
    },
  })
  @ApiOperation({ summary: 'OWNER: upload a poster; enabled by default, 8 seconds per slide' })
  @ApiCreatedResponse({ type: DisplayPosterResponseDto })
  upload(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @UploadedFile() file: PosterFile | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.upload(chainId, file, user);
  }

  @Patch(':posterId')
  @ApiOperation({
    summary: 'OWNER: change title, enabled state, position or duration (3–60 seconds)',
  })
  @ApiOkResponse({ type: DisplayPosterResponseDto })
  update(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('posterId', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateDisplayPosterDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.update(chainId, id, dto, user);
  }

  @Delete(':posterId')
  @ApiOperation({ summary: 'OWNER: soft-delete a chain poster; existing cached asset is retained' })
  remove(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('posterId', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.remove(chainId, id, user);
  }
}
