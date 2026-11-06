import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import {
  MENU_IMPORT_MAX_BYTES,
  MENU_IMPORT_MAX_FILES,
  MenuImportsService,
  type MenuImportFile,
} from './menu-imports.service.js';

@ApiTags('Menu imports (Brand Manager)')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@Roles(AppRole.OWNER)
@Controller('restaurant-chains/:chainId/menu-imports')
export class MenuImportsController {
  constructor(private readonly service: MenuImportsService) {}

  @Post()
  @UseInterceptors(
    FilesInterceptor('files', MENU_IMPORT_MAX_FILES, {
      limits: { files: MENU_IMPORT_MAX_FILES, fileSize: MENU_IMPORT_MAX_BYTES },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['files'],
      properties: {
        files: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          items: { type: 'string', format: 'binary' },
        },
      },
    },
  })
  @ApiOperation({ summary: 'Upload 1–5 menu images and start background OCR + AI structuring' })
  create(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @UploadedFiles() files: MenuImportFile[] | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.create(chainId, files, user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read OCR/AI status and the editable menu draft' })
  get(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.get(chainId, id, user);
  }

  @Put(':id/draft')
  @ApiOperation({ summary: 'Save the Brand Manager reviewed menu draft' })
  updateDraft(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() draft: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.updateDraft(chainId, id, draft, user);
  }

  @Post(':id/commit')
  @ApiOperation({ summary: 'Atomically import the reviewed draft into the chain menu' })
  commit(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.commit(chainId, id, user);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Cancel a processing or reviewable menu import' })
  cancel(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.cancel(chainId, id, user);
  }
}
