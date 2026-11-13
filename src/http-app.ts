import type { INestApplication } from '@nestjs/common';
import { StandardSchemaValidationPipe } from '@nestjs/common';
import { Correlation } from './shared/infrastructure/correlation';
import { HttpExceptionFilter, schemaIssuesToError } from './shared/presentation/http-exception.filter';

/** HTTP pipeline shared by main.ts and the test app, so tests run the real one. */
export function configureHttpApp(app: INestApplication): void {
  app.use(Correlation.middleware);
  app.useGlobalPipes(new StandardSchemaValidationPipe({ exceptionFactory: schemaIssuesToError }));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();
}
