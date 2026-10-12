import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const task = process.argv[2];
const compiledSmoke = process.argv.includes('--compiled-smoke');
if (!['test:integration', 'test:e2e'].includes(task ?? ''))
  throw new Error('Choose test:integration or test:e2e');
const root = resolve(import.meta.dirname, '..');
const project = `ais-fusion-verify-${process.pid}`;
const compose = ['compose', '-p', project, '-f', 'infra/compose.test.yaml'];
const environment = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://ais:ais-local-only@127.0.0.1:15433/ais',
  CLICKHOUSE_URL: 'http://127.0.0.1:18124',
  CLICKHOUSE_USER: 'ais',
  CLICKHOUSE_PASSWORD: 'ais-local-only',
  CLICKHOUSE_DATABASE: 'ais',
  NATS_URL: 'nats://127.0.0.1:14223',
  NATS_TOKEN: '',
  S3_ENDPOINT: 'http://127.0.0.1:19001',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'ais-raw',
  S3_ACCESS_KEY_ID: 'ais-local',
  S3_SECRET_ACCESS_KEY: 'ais-local-only-secret',
  CI: 'true',
};
async function run(executable: string, args: string[]) {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
      env: environment,
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolveRun() : reject(new Error(`Isolated ${args[0]} exited ${code}`)),
    );
  });
}
try {
  await run('docker', [...compose, 'up', '-d', '--wait']);
  await run(process.execPath, ['--import', 'tsx', 'scripts/workspace.ts', 'migrate']);
  await run(process.execPath, [
    '--import',
    'tsx',
    'scripts/workspace.ts',
    task!,
    ...process.argv.slice(3).filter((argument) => argument !== '--compiled-smoke'),
  ]);
  if (compiledSmoke) {
    if (task !== 'test:e2e') throw new Error('--compiled-smoke requires the E2E demo dataset');
    await run(process.execPath, ['--import', 'tsx', 'scripts/workspace.ts', 'build:smoke']);
  }
} finally {
  // Only this process's uniquely named test project is removed; development volumes are separate.
  await run('docker', [...compose, 'down', '--volumes']);
}
