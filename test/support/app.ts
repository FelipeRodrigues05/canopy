import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureHttpApp } from '../../src/http-app';

/**
 * Boots the real AppModule (real Postgres, real LocalStack). Nothing is
 * overridden: mocking the database or the broker is disqualifying.
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureHttpApp(app);
  await app.init();
  return app;
}
