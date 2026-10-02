import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { mkdir } from 'node:fs/promises';
import { AppModule } from './app.module.js';
import { configureApplication } from './app.setup.js';
import { configureSwagger } from './swagger.setup.js';
import { ConfiguredSocketIoAdapter } from './realtime/socket-io.adapter.js';
import { getUploadRootDirectory } from './modules/branding/branding-upload.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);
  const realtimePath = configService.get<string>('REALTIME_PATH', '/socket.io');
  const realtimeOrigins = configService.get<string[]>('REALTIME_CORS_ORIGINS', ['*']);
  const uploadDirectory = getUploadRootDirectory();
  await mkdir(uploadDirectory, { recursive: true });
  app.useStaticAssets(uploadDirectory, { prefix: '/uploads/' });
  app.useWebSocketAdapter(new ConfiguredSocketIoAdapter(app, realtimePath, realtimeOrigins));
  configureApplication(app);
  configureSwagger(app);

  await app.listen(port, '0.0.0.0');
}

void bootstrap();
