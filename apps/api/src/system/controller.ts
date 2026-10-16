import { Controller, Get, Inject, Res } from '@nestjs/common';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { busHealth, type Infrastructure } from '@ais/infrastructure';
import { Registry, collectDefaultMetrics } from 'prom-client';
import type { Response } from 'express';
import { z } from 'zod';
import { DocumentRoute, INFRA, MinimumRole, Public } from '../common';
export const HealthSchema = z.object({
  status: z.enum(['ready', 'degraded']),
  services: z.object({
    postgres: z.boolean(),
    clickhouse: z.boolean(),
    nats: z.boolean(),
    s3: z.boolean(),
  }),
  sources: z.object({
    enabled: z.number(),
    latestReceivedAt: z.string().nullable(),
    empty: z.boolean(),
  }),
  bus: z.object({
    status: z.string(),
    ready: z.boolean(),
    reasons: z.array(z.string()),
    streams: z.array(
      z.object({
        name: z.string(),
        bytes: z.number(),
        limit: z.number(),
        oldestAgeMs: z.number(),
        pendingAgeMs: z.number(),
        activeStreamingCommands: z.number(),
        messages: z.number(),
      }),
    ),
  }),
});
@Controller('system')
export class SystemController {
  private readonly metrics = new Registry();
  constructor(@Inject(INFRA) private readonly infra: Infrastructure) {
    collectDefaultMetrics({ register: this.metrics, prefix: 'ais_api_' });
  }
  @Public()
  @Get('health')
  @DocumentRoute('Real dependency and source health', HealthSchema)
  async health() {
    const checks = await Promise.allSettled([
      this.infra.pool.query('SELECT 1'),
      this.infra.clickhouse.ping(),
      this.infra.nc.flush(),
      this.infra.s3.send(new HeadBucketCommand({ Bucket: this.infra.config.s3Bucket })),
    ]);
    const services = {
      postgres: checks[0].status === 'fulfilled',
      clickhouse:
        checks[1].status === 'fulfilled' && (checks[1].value as { success: boolean }).success,
      nats: checks[2].status === 'fulfilled' && !this.infra.nc.isClosed(),
      s3: checks[3].status === 'fulfilled',
    };
    let enabled = 0;
    let latest: string | null = null;
    if (services.postgres) {
      const result = await this.infra.pool.query(
        'SELECT count(*) FILTER(WHERE enabled)::int AS enabled,max(last_received_at) AS latest FROM sources',
      );
      enabled = result.rows[0].enabled;
      latest = result.rows[0].latest?.toISOString() ?? null;
    }
    const bus = await busHealth(this.infra);
    return {
      status: Object.values(services).every(Boolean) && bus.ready ? 'ready' : 'degraded',
      services,
      sources: { enabled, latestReceivedAt: latest, empty: latest === null },
      bus,
    };
  }
  @Get('ready')
  @DocumentRoute('Readiness returns 503 when a dependency is unavailable', HealthSchema)
  async ready(@Res({ passthrough: true }) res: Response) {
    const value = await this.health();
    if (value.status !== 'ready') res.status(503);
    return value;
  }
  @Get('metrics')
  @MinimumRole('admin')
  @DocumentRoute('Prometheus process metrics with no credentials or session labels', z.string())
  async getMetrics(@Res() res: Response) {
    res.type(this.metrics.contentType).send(await this.metricsText());
  }
  metricsText() {
    return this.metrics.metrics();
  }
  metricsContentType() {
    return this.metrics.contentType;
  }
}
