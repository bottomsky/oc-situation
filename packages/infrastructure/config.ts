export interface InfrastructureConfig {
  production: boolean;
  databaseUrl: string;
  clickhouseUrl: string;
  clickhouseUser: string;
  clickhousePassword: string;
  clickhouseDatabase: string;
  natsUrl: string;
  natsToken?: string;
  s3Endpoint?: string;
  s3Region: string;
  s3Bucket: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): InfrastructureConfig {
  const production = env.NODE_ENV === 'production';
  const required = (key: string, fallback: string): string => {
    const value = env[key];
    if (value) return value;
    if (production) throw new Error(`Missing required production configuration: ${key}`);
    return fallback;
  };
  if (production && env.S3_ENDPOINT?.includes('localhost'))
    throw new Error('Production S3 must be external');
  return {
    production,
    databaseUrl: required('DATABASE_URL', 'postgresql://ais:ais-local-only@127.0.0.1:15432/ais'),
    clickhouseUrl: required('CLICKHOUSE_URL', 'http://127.0.0.1:18123'),
    clickhouseUser: env.CLICKHOUSE_USER ?? 'ais',
    clickhousePassword: required('CLICKHOUSE_PASSWORD', 'ais-local-only'),
    clickhouseDatabase: env.CLICKHOUSE_DATABASE ?? 'ais',
    natsUrl: required('NATS_URL', 'nats://127.0.0.1:14222'),
    ...(env.NATS_TOKEN ? { natsToken: env.NATS_TOKEN } : {}),
    ...(env.S3_ENDPOINT
      ? { s3Endpoint: env.S3_ENDPOINT }
      : production
        ? {}
        : { s3Endpoint: 'http://127.0.0.1:19000' }),
    s3Region: env.S3_REGION ?? 'us-east-1',
    s3Bucket: required('S3_BUCKET', 'ais-raw'),
    ...(env.S3_ACCESS_KEY_ID
      ? { s3AccessKey: env.S3_ACCESS_KEY_ID }
      : production
        ? {}
        : { s3AccessKey: 'ais-local' }),
    ...(env.S3_SECRET_ACCESS_KEY
      ? { s3SecretKey: env.S3_SECRET_ACCESS_KEY }
      : production
        ? {}
        : { s3SecretKey: 'ais-local-only-secret' }),
  };
}
