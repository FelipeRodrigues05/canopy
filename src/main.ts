import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { Env } from './config/env.schema';
import { configureHttpApp } from './http-app';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureHttpApp(app);

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const roles = config.get('APP_ROLES', { infer: true });

  if (roles.includes('api')) {
    await app.listen(config.get('PORT', { infer: true }));
  } else {
    await app.init();
  }
  app.get(Logger).log({ msg: 'canopy started', roles, port: config.get('PORT', { infer: true }) }, 'Bootstrap');
}

void bootstrap();
