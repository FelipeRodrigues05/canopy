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
    // Keep idle connections open longer than any load balancer in front
    // (nginx, AWS ALB: 60 s). Otherwise the server may close a connection
    // the balancer is about to reuse, and the client gets a 502.
    const server = app.getHttpServer() as { keepAliveTimeout: number; headersTimeout: number };
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    await app.listen(config.get('PORT', { infer: true }));
  } else {
    await app.init();
  }
  app.get(Logger).log({ msg: 'canopy started', roles, port: config.get('PORT', { infer: true }) }, 'Bootstrap');
}

void bootstrap();
