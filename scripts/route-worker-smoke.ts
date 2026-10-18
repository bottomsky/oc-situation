import { Worker } from 'node:worker_threads';
import assert from 'node:assert/strict';
import { routeWorkerSource } from '../packages/infrastructure/route-planning';
const worker = new Worker(routeWorkerSource(), {
  eval: true,
  workerData: [
    {
      nodes: [
        { id: 'a', coordinate: [179, 0] },
        { id: 'b', coordinate: [-179, 0] },
      ],
      edges: [
        {
          from: 'a',
          to: 'b',
          coordinates: [
            [179, 0],
            [-179, 0],
          ],
        },
      ],
      start: [[179, 0], ['a']],
      end: [[-179, 0], ['b']],
    },
  ],
});
try {
  const result = await new Promise<{ error?: string; lengthMeters: number }>((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  assert.equal(result.error, undefined);
  assert(result.lengthMeters > 222000 && result.lengthMeters < 223000);
  console.log('route worker compiled smoke passed');
} finally {
  await worker.terminate();
}
