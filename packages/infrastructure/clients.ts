import pg from 'pg';
import { createClient } from '@clickhouse/client';
import { S3Client } from '@aws-sdk/client-s3';
import { connect } from '@nats-io/transport-node';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import pino from 'pino';
import { loadConfig, type InfrastructureConfig } from './config';

export const logger = pino({
  redact: {
    paths: [
      'password',
      'passwordHash',
      'password_hash',
      'token',
      'authorization',
      'secret',
      'apiKey',
      'credentials',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.secret',
      '*.apiKey',
      'headers.authorization',
      'config.secretRef',
    ],
    censor: '[REDACTED]',
  },
});

export async function createInfrastructure(config: InfrastructureConfig = loadConfig()) {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 20,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (error) =>
    logger.error({ error: error.message }, 'PostgreSQL idle connection error'),
  );
  const clickhouse = createClient({
    url: config.clickhouseUrl,
    username: config.clickhouseUser,
    password: config.clickhousePassword,
    database: config.clickhouseDatabase,
    request_timeout: 30_000,
  });
  const s3 = new S3Client({
    region: config.s3Region,
    ...(config.s3Endpoint ? { endpoint: config.s3Endpoint, forcePathStyle: true } : {}),
    ...(config.s3AccessKey && config.s3SecretKey
      ? { credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey } }
      : {}),
  });
  const nc = await connect({
    servers: config.natsUrl,
    ...(config.natsToken ? { token: config.natsToken } : {}),
    reconnect: true,
    maxReconnectAttempts: -1,
  });
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  return {
    config,
    pool,
    clickhouse,
    s3,
    nc,
    js,
    jsm,
    async close() {
      await nc.drain();
      await pool.end();
      await clickhouse.close();
      s3.destroy();
    },
  };
}
export type Infrastructure = Awaited<ReturnType<typeof createInfrastructure>>;
