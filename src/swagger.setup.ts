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
      [
        'REST API for the Smart F&B Chain Platform.',
        '',
        '## Waiter and Kitchen Staff flow',
        '1. A waiter creates an order, adds items, and submits it.',
        '2. Kitchen staff process submitted items through the kitchen queue.',
        '3. Ready items create serving tasks that waiters claim and complete.',
        '',
        'Protected endpoints require the access token returned by `POST /api/v1/auth/login`.',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addTag('Waiter · Orders', 'Table context and the waiter order lifecycle.')
    .addTag('Kitchen · Queue', 'Kitchen queue and food-preparation state transitions.')
    .addTag('Waiter · Serving', 'Ready-item handoff from kitchen staff to waiters.')
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

  const documentFactory = () =>
    SwaggerModule.createDocument(app, documentConfig, {
      operationIdFactory: (controllerKey, methodKey) =>
        `${controllerKey.replace(/Controller$/, '')}_${methodKey}`,
    });

  SwaggerModule.setup(swaggerPath, app, documentFactory, {
    customSiteTitle: 'Smart F&B API Documentation',
    swaggerOptions: {
      deepLinking: true,
      displayRequestDuration: true,
      filter: true,
      persistAuthorization: true,
      tryItOutEnabled: true,
    },
  });
}
