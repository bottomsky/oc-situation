import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketLifecycleConfigurationCommand,
} from '@aws-sdk/client-s3';
import type { Infrastructure } from './clients';
import { bootstrapJetstream } from './bus';
import { logger } from './clients';
export async function bootstrapS3(infra: Infrastructure): Promise<void> {
  try {
    await infra.s3.send(new HeadBucketCommand({ Bucket: infra.config.s3Bucket }));
  } catch (error) {
    if (infra.config.production) throw error;
    await infra.s3.send(new CreateBucketCommand({ Bucket: infra.config.s3Bucket }));
  }
  try {
    await infra.s3.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: infra.config.s3Bucket,
        LifecycleConfiguration: {
          Rules: [
            {
              ID: 'ais-raw-fallback-91-days',
              Status: 'Enabled',
              Filter: { Prefix: 'raw/' },
              Expiration: { Days: 91 },
            },
            {
              ID: 'ais-artifact-fallback-91-days',
              Status: 'Enabled',
              Filter: { Prefix: 'artifacts/' },
              Expiration: { Days: 91 },
            },
          ],
        },
      }),
    );
  } catch (error) {
    if (infra.config.production) throw error;
    logger.warn(
      { error: error instanceof Error ? error.message : 'Lifecycle unsupported' },
      'Development S3 lifecycle fallback unavailable; application expiry remains active',
    );
  }
}
export async function seedDemo(infra: Infrastructure): Promise<void> {
  await bootstrapJetstream(infra);
  await bootstrapS3(infra);
  const fixturesEnabled = !infra.config.production;
  await infra.pool.query(
    `INSERT INTO sources(id,name,kind,enabled,priority,status,config) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(id) DO NOTHING`,
    [
      'fixture-http',
      '本地 AIS 样例',
      'fixture-http',
      fixturesEnabled,
      100,
      fixturesEnabled ? 'enabled' : 'disabled',
      JSON.stringify({
        endpoint: 'http://127.0.0.1:13002/ais.json',
        settings: {
          allowedHosts: ['127.0.0.1'],
          authorizationConfirmed: fixturesEnabled,
          requestsPerMinute: 4,
          httpConcurrency: 1,
        },
      }),
    ],
  );
  for (const [id, name, kind, priority] of [
    ['aisstream', 'AISStream', 'aisstream', 200],
    ['marinetraffic', 'MarineTraffic', 'marinetraffic', 300],
  ] as const)
    await infra.pool.query(
      'INSERT INTO sources(id,name,kind,enabled,priority,status,config) VALUES($1,$2,$3,false,$4,$5,$6::jsonb) ON CONFLICT(id) DO NOTHING',
      [
        id,
        name,
        kind,
        priority,
        'disabled',
        JSON.stringify({ settings: { authorizationConfirmed: false } }),
      ],
    );
  await infra.pool.query(
    'INSERT INTO jobs(id,source_id,name,enabled,status,mode,schedule_seconds) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING',
    [
      '00000000-0000-4000-8000-000000000001',
      'fixture-http',
      '本地样例采集',
      fixturesEnabled,
      fixturesEnabled ? 'enabled' : 'paused',
      'crawl',
      900,
    ],
  );
}
