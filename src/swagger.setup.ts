import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { SWAGGER_ACCESS_TOKEN } from './modules/auth/auth.constants.js';

export function configureSwagger(app: INestApplication): void {
  const configService = app.get(ConfigService);

  if (!configService.get<boolean>('SWAGGER_ENABLED', true)) {
    return;
  }

  const swaggerPath = configService.get<string>('SWAGGER_PATH', 'api/docs');
  const documentConfig = new DocumentBuilder()
    .setTitle('Smart F&B Chain Platform API')
    .setDescription(
      'REST API for restaurant-chain authentication, users, branches, menus, orders, payments, loyalty, and attendance.',
    )
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Access token returned by POST /api/v1/auth/login',
      },
      SWAGGER_ACCESS_TOKEN,
    )
    .build();

  const documentFactory = () => SwaggerModule.createDocument(app, documentConfig);

  SwaggerModule.setup(swaggerPath, app, documentFactory, {
    customSiteTitle: 'Smart F&B API Documentation',
    swaggerOptions: {
      persistAuthorization: true,
    },
  });
}
