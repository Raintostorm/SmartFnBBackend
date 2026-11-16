import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { json, Router } from 'express';
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
  // Nest detects global parsers by middleware name. Keep the scoped parser inside a router.
  const importRouter = Router();
  importRouter.use(['/excel', '/:id/draft'], json({ limit: '8mb' }));
  app.use(importsPath, importRouter);
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.enableShutdownHooks();
}
