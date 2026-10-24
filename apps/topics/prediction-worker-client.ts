import { Worker } from 'node:worker_threads';
import type {
  NavigationWarning,
  NavigationWarningImpact,
  PredictionArea,
  PredictionPath,
  ReachabilityDependencies,
  ReachabilityInput,
  ReachabilityPrediction,
} from '../../packages/contracts/reachability';

export interface PredictionWorkerOutput {
  prediction: ReachabilityPrediction;
  impacts: (NavigationWarningImpact & {
    geometry?: PredictionArea;
    documentId?: string;
    relationId?: string;
    relationRevision?: number;
  })[];
  skipped: { warningId: string; reason: string }[];
}
export interface PredictionWorkerInput {
  input: ReachabilityInput;
  warnings: NavigationWarning[];
  vessel: { mmsi: string; shipType: number | null };
  landAvailable: boolean;
  warningReferences?: {
    warningId: string;
    documentId: string;
    relationId: string;
    revision: number;
  }[];
}
interface WorkerLike {
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  postMessage(message: unknown): void;
  terminate(): Promise<number>;
}
let activeWorkers = 0;
export function executePredictionWorker(
  request: PredictionWorkerInput,
  dependencies: ReachabilityDependencies,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    workerFactory?: (request: PredictionWorkerInput) => WorkerLike;
  } = {},
): Promise<PredictionWorkerOutput> {
  if (options.signal?.aborted) return Promise.reject(new Error('Prediction execution cancelled'));
  if (activeWorkers >= 2) return Promise.reject(new Error('Prediction worker capacity reached'));
  const create =
    options.workerFactory ??
    ((input) =>
      new Worker(
        new URL(
          import.meta.url.endsWith('.ts') ? './prediction-worker.ts' : './prediction-worker.mjs',
          import.meta.url,
        ),
        {
          workerData: input,
          execArgv: import.meta.url.endsWith('.ts') ? ['--import', 'tsx'] : [],
          resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
        },
      ));
  let worker: WorkerLike;
  try {
    worker = create(request);
  } catch (error) {
    return Promise.reject(error);
  }
  activeWorkers++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, output?: PredictionWorkerOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      void worker.terminate().finally(() => {
        activeWorkers--;
      });
      if (error) reject(error);
      else resolve(output!);
    };
    const abort = () => finish(new Error('Prediction execution cancelled'));
    const timer = setTimeout(
      () => finish(new Error('Prediction worker timed out')),
      options.timeoutMs ?? 30_000,
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    let checking = false;
    worker.on('message', (raw) => {
      if (settled) return;
      const message = raw as {
        type: string;
        paths?: PredictionPath[];
        requestId?: number;
        output?: PredictionWorkerOutput;
        error?: string;
      };
      if (message.type === 'checkPaths') {
        if (
          checking ||
          !request.landAvailable ||
          !dependencies.checkPaths ||
          !message.paths ||
          message.paths.length > 2048
        )
          return finish(new Error('Invalid prediction land-check request'));
        checking = true;
        void dependencies.checkPaths(message.paths).then(
          (allowed) => {
            if (settled) return;
            if (allowed.length !== message.paths!.length)
              return finish(new Error('Land-check response does not cover every path'));
            worker.postMessage({ type: 'landResult', requestId: message.requestId, allowed });
          },
          (error: unknown) =>
            finish(error instanceof Error ? error : new Error('Prediction land check failed')),
        );
      } else if (message.type === 'result' && message.output) finish(undefined, message.output);
      else if (message.type === 'error')
        finish(new Error(message.error ?? 'Prediction worker failed'));
      else finish(new Error('Invalid prediction worker message'));
    });
    worker.on('error', (error) => finish(error));
    worker.on('exit', (code) => {
      if (!settled) finish(new Error(`Prediction worker exited before result (${code})`));
    });
  });
}
