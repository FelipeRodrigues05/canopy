import { Controller, Get, Header } from '@nestjs/common';
import { Registry } from 'prom-client';
import { Public } from '../auth/presentation/public.decorator';

/** Scraped by Prometheus inside the network; protect at the network layer in production. */
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly registry: Registry) {}

  /** Prometheus text format. Gauges that need the database (outbox lag) are computed on scrape. */
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.registry.metrics();
  }
}
