import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { DatabaseHealthIndicator } from './database.health-indicator';
import { SqsHealthIndicator } from './sqs.health-indicator';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: DatabaseHealthIndicator,
    private readonly sqs: SqsHealthIndicator,
  ) {}

  /** The process is up and the event loop answers. Never touches dependencies. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Ready to take traffic: Postgres answers `SELECT 1` and the wager queue is reachable. */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.db.isHealthy('database'),
      () => this.sqs.isHealthy('sqs'),
    ]);
  }
}
