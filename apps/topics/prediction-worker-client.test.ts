import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { executePredictionWorker, type PredictionWorkerInput } from './prediction-worker-client';

const request: PredictionWorkerInput = {
  input: { mmsi: '413000001', asOf: '2026-10-24T00:00:00.000Z', observations: [] },
  warnings: [],
  vessel: { mmsi: '413000001', shipType: null },
  landAvailable: false,
};
class FakeWorker extends EventEmitter {
  stopped = false;
  postMessage() {}
  async terminate() {
    this.stopped = true;
    return 0;
  }
}
describe('isolated prediction supervisor', () => {
  it('terminates work on timeout and cancellation', async () => {
    const worker = new FakeWorker();
    await expect(
      executePredictionWorker(request, {}, { workerFactory: () => worker, timeoutMs: 15 }),
    ).rejects.toThrow('timed out');
    expect(worker.stopped).toBe(true);
    const controller = new AbortController();
    const cancelled = executePredictionWorker(
      request,
      {},
      { workerFactory: () => worker, signal: controller.signal },
    );
    controller.abort();
    await expect(cancelled).rejects.toThrow('cancelled');
  });
  it('enforces two concurrent workers and releases both slots after exit', async () => {
    const a = new FakeWorker(),
      b = new FakeWorker();
    const first = executePredictionWorker(request, {}, { workerFactory: () => a });
    const second = executePredictionWorker(request, {}, { workerFactory: () => b });
    const rejectedFirst = expect(first).rejects.toThrow('exit');
    const rejectedSecond = expect(second).rejects.toThrow('exit');
    await expect(
      executePredictionWorker(request, {}, { workerFactory: () => new FakeWorker() }),
    ).rejects.toThrow('capacity');
    a.emit('exit', 1);
    b.emit('exit', 1);
    await Promise.all([rejectedFirst, rejectedSecond]);
  });
  it('executes the real TypeScript worker for a data-insufficiency result', async () => {
    const output = await executePredictionWorker(request, {});
    expect(output.prediction.summary.status).toBe('insufficient_data');
    expect(output.prediction.paths).toEqual([]);
  });
});
