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
        '## V8 counter-service flow',
        '1. A cashier creates and finalizes a counter order.',
        '2. Cash or a verified payment queues the order and assigns a daily call number.',
        '3. Baristas prepare individual cups or portions, then hand over the complete order.',
        '',
        'Protected endpoints require the access token returned by `POST /api/v1/auth/login`.',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addTag('Waiter · Orders', 'Table context and the waiter order lifecycle.')
    .addTag('Kitchen · Queue', 'Kitchen queue and food-preparation state transitions.')
    .addTag('Waiter · Serving', 'Ready-item handoff from kitchen staff to waiters.')
    .addTag('Cashier · Orders', 'Counter POS drafts, menu options, and order finalization.')
    .addTag('Cashier · Payments', 'Prepaid counter-order payment processing.')
    .addTag('Barista · Queue', 'Paid preparation queue and per-unit progress.')
    .addTag('Barista · Availability', 'Branch-level menu item and option availability.')
    .addTag('Tables', 'Branch floor plan, table status, and merge adjacency configuration.')
    .addTag('Payments', 'Branch payment history and table-session payment processing.')
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
