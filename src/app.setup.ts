import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { json } from 'express';
import { ConfigService } from '@nestjs/config';

export function configureApplication(app: INestApplication): void {
  const configService = app.get(ConfigService);
  const apiPrefix = configService.get<string>('API_PREFIX', 'api/v1');
  const corsOrigins = configService
    .get<string>('CORS_ORIGIN', '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.setGlobalPrefix(apiPrefix);
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    credentials: true,
  });
  const importsPath = `/${apiPrefix}/restaurant-chains/:chainId/menu-imports`;
  app.use([`${importsPath}/excel`, `${importsPath}/:id/draft`], json({ limit: '8mb' }));
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.enableShutdownHooks();
}
