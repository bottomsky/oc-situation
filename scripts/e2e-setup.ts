import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export default async function setup() {
  const path = resolve(import.meta.dirname, '../.data/demo-admin.json');
  const credentials = JSON.parse(await readFile(path, 'utf8')) as {
    username: string;
    password: string;
    operator: { username: string; password: string };
    viewer: { username: string; password: string };
  };
  if (!credentials.username || !credentials.password) throw new Error('Demo credentials missing');
  process.env.E2E_USERNAME = credentials.username;
  process.env.E2E_PASSWORD = credentials.password;
  process.env.E2E_OPERATOR_USERNAME = credentials.operator.username;
  process.env.E2E_OPERATOR_PASSWORD = credentials.operator.password;
  process.env.E2E_VIEWER_USERNAME = credentials.viewer.username;
  process.env.E2E_VIEWER_PASSWORD = credentials.viewer.password;
  process.env.E2E_MMSI = '413793000';
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const ready = JSON.parse(
        await readFile(resolve(import.meta.dirname, '../.data/demo-ready.json'), 'utf8'),
      ) as { ready: boolean };
      if (ready.ready) return;
    } catch {
      /* demo pipeline is still initializing */
    }
    await delay(1000);
  }
  throw new Error('Demo data did not become ready');
}
