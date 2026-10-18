import { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { routeWorkerSource } from './route-planning';
it('executes real worker-thread source and computes a complete route', async () => {
  const worker = new Worker(routeWorkerSource(), {
    eval: true,
    workerData: [
      {
        nodes: [
          { id: 'a', coordinate: [0, 0] },
          { id: 'b', coordinate: [1, 0] },
        ],
        edges: [
          {
            from: 'a',
            to: 'b',
            coordinates: [
              [0, 0],
              [1, 0],
            ],
          },
        ],
        start: [[0, 0], ['a']],
        end: [[1, 0], ['b']],
      },
    ],
  });
  try {
    const value = await new Promise<{ lengthMeters: number; error?: string }>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    expect(value.error).toBeUndefined();
    expect(value.lengthMeters).toBeGreaterThan(111000);
  } finally {
    await worker.terminate();
  }
});

it('executes the worker through the real tsx development loader', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const result = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', 'scripts/route-worker-smoke.ts'],
    { timeout: 15000 },
  );
  expect(result.stdout).toContain('route worker compiled smoke passed');
  expect(result.stderr).toBe('');
}, 20000);
