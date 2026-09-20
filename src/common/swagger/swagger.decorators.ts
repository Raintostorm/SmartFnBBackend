import { applyDecorators, HttpStatus, type Type } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
  ApiResponse,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiProperty } from '@nestjs/swagger';

export class ApiErrorDto {
  @ApiProperty({ example: 409 })
  statusCode!: number;

  @ApiProperty({ oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] })
  message!: string | string[];

  @ApiProperty({ example: 'Conflict' })
  error!: string;
}

export class PageMetaDto {
  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 3 })
  pageCount!: number;
}

export function ApiAuthenticatedOperation() {
  return applyDecorators(
    ApiUnauthorizedResponse({
      description: 'Access token is missing, invalid, or expired',
      type: ApiErrorDto,
    }),
    ApiForbiddenResponse({
      description: 'The authenticated role or branch scope is not allowed',
      type: ApiErrorDto,
    }),
  );
}

export function ApiUuidPath(name: string, description: string) {
  return ApiParam({
    name,
    description,
    format: 'uuid',
    example: '11111111-1111-4111-8111-111111111111',
  });
}

export function ApiStandardMutationErrors(options: { notFound?: string; conflict?: string } = {}) {
  const decorators = [
    ApiBadRequestResponse({
      description: 'Request validation or state transition failed',
      type: ApiErrorDto,
    }),
  ];
  if (options.notFound)
    decorators.push(ApiNotFoundResponse({ description: options.notFound, type: ApiErrorDto }));
  if (options.conflict)
    decorators.push(
      ApiResponse({
        status: HttpStatus.CONFLICT,
        description: options.conflict,
        type: ApiErrorDto,
      }),
    );
  return applyDecorators(...decorators);
}

export function ApiPaginatedResponse<T extends Type<unknown>>(model: T, description: string) {
  return applyDecorators(
    ApiExtraModels(model, PageMetaDto),
    ApiOkResponse({
      description,
      schema: {
        type: 'object',
        required: ['data', 'meta'],
        properties: {
          data: { type: 'array', items: { $ref: getSchemaPath(model) } },
          meta: { $ref: getSchemaPath(PageMetaDto) },
        },
      },
    }),
  );
}
