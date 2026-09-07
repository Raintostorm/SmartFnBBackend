import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApplication } from './app.setup.js';
import { configureSwagger } from './swagger.setup.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);
  configureApplication(app);
  configureSwagger(app);

  await app.listen(port, '0.0.0.0');
}

void bootstrap();
