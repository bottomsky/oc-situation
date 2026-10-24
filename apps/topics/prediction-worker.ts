import { parentPort, workerData } from 'node:worker_threads';
import { predictVesselReachability } from '../../packages/domain/reachability';
import { evaluateNavigationWarningImpact } from '../../packages/domain/navigation-warning-impact';
import type { PredictionWorkerInput, PredictionWorkerOutput } from './prediction-worker-client';
import type { PredictionPath } from '../../packages/contracts/reachability';

const port = parentPort;
if (!port) throw new Error('Prediction worker requires an isolated worker thread');
const request = workerData as PredictionWorkerInput;
async function checkPaths(paths: PredictionPath[]) {
  return new Promise<boolean[]>((resolve, reject) => {
    const listener = (message: {
      type: string;
      requestId: number;
      allowed?: boolean[];
      error?: string;
    }) => {
      if (message.type !== 'landResult' || message.requestId !== 1) return;
      port!.off('message', listener);
      if (message.error || !message.allowed)
        reject(new Error(message.error ?? 'Land check failed'));
      else resolve(message.allowed);
    };
    port!.on('message', listener);
    port!.postMessage({ type: 'checkPaths', requestId: 1, paths });
  });
}
try {
  const prediction = await predictVesselReachability(
    request.input,
    request.landAvailable ? { checkPaths } : {},
  );
  const impact = evaluateNavigationWarningImpact({
    prediction,
    warnings: request.warnings,
    vessel: request.vessel,
  });
  const geometries = new Map(request.warnings.map((warning) => [warning.id, warning.geometry]));
  const references = new Map(
    request.warningReferences?.map((reference) => [reference.warningId, reference]),
  );
  const output: PredictionWorkerOutput = {
    prediction,
    impacts: impact.impacts.map((item) => ({
      ...item,
      geometry: geometries.get(item.warningId),
      documentId: references.get(item.warningId)?.documentId,
      relationId: references.get(item.warningId)?.relationId,
      relationRevision: references.get(item.warningId)?.revision,
    })),
    skipped: impact.skipped,
  };
  port.postMessage({ type: 'result', output });
} catch (error) {
  port.postMessage({
    type: 'error',
    error: error instanceof Error ? error.message : String(error),
  });
}
