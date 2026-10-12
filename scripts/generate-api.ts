import { spawn } from 'node:child_process';
import { createInfrastructure } from '@ais/infrastructure';
import { writeFile } from 'node:fs/promises';
import { createApi } from '../apps/api/src/app';
const infra = await createInfrastructure();
try {
  const api = await createApi(infra, { scheduler: false });
  await writeFile('apps/api/openapi.json', `${JSON.stringify(api.openapi, null, 2)}\n`);
  await api.stop();
} finally {
  await infra.close();
}
await new Promise<void>((ok, bad) => {
  const proc = spawn(
    process.execPath,
    [
      'node_modules/openapi-typescript/bin/cli.js',
      'apps/api/openapi.json',
      '-o',
      'apps/web/app/types/api.generated.ts',
    ],
    { stdio: 'inherit', shell: false },
  );
  proc.once('error', bad);
  proc.once('exit', (code) => (code === 0 ? ok() : bad(new Error('OpenAPI generation failed'))));
});
