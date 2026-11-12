import type { INestApplication } from '@nestjs/common';
import { Registry } from 'prom-client';

/** Current value of a counter/gauge series in an app instance's registry (0 when absent). */
export async function metricValue(app: INestApplication, name: string, labels: Record<string, string> = {}): Promise<number> {
  const metric = app.get(Registry).getSingleMetric(name);
  if (!metric) throw new Error(`metric ${name} not registered`);
  const { values } = await metric.get();
  return values
    .filter((v) => Object.entries(labels).every(([k, val]) => String(v.labels[k]) === val))
    .reduce((sum, v) => sum + v.value, 0);
}
