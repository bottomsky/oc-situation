import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  AnalysisResultSchema,
  type AnalysisResult,
  type TopicDataset,
  type TopicInstance,
} from '../../packages/contracts/topics';
import { analysisIdentity } from '../../packages/domain/topics';

export interface TopicExecutionRequest {
  protocolVersion: 1;
  instance: TopicInstance;
  dataset: TopicDataset;
}
const ResponseSchema = z.strictObject({
  protocolVersion: z.literal(1),
  results: z.array(AnalysisResultSchema).max(10000),
});
/** Deployment-owned argv JSON; never accepts commands from an end-user API request. */
export async function executeExternalTopic(
  command: string,
  instance: TopicInstance,
  dataset: TopicDataset,
  timeoutMs = 60_000,
): Promise<AnalysisResult[]> {
  const argv = z.array(z.string().min(1).max(4096)).min(1).max(30).parse(JSON.parse(command));
  const input = JSON.stringify({
    protocolVersion: 1,
    instance,
    dataset,
  } satisfies TopicExecutionRequest);
  if (Buffer.byteLength(input) > 32 * 1024 * 1024) throw new Error('Executor input exceeds 32 MiB');
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        PYTHONIOENCODING: 'utf-8',
      },
    });
    const chunks: Buffer[] = [];
    let length = 0;
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill();
        reject(error);
      } else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(() => finish(new Error('Topic executor timed out')), timeoutMs);
    child.on('error', finish);
    child.stdin.on('error', () => {
      /* A failed child can close stdin before its exit event. */
    });
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > 32 * 1024 * 1024) {
        finish(new Error('Executor output exceeds 32 MiB'));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString('utf8').slice(0, 2000 - stderr.length);
    });
    child.on('close', (code) =>
      finish(code === 0 ? undefined : new Error(`Topic executor exited ${code}: ${stderr}`)),
    );
    child.stdin.end(input);
  });
  const response = ResponseSchema.parse(JSON.parse(output));
  const positions = new Map(dataset.ais.map((p) => [p.recordId, p]));
  const documents = new Map(dataset.intelligence.map((d) => [d.id, d]));
  const ids = new Set<string>();
  for (const result of response.results) {
    if (
      result.instanceId !== instance.id ||
      result.definitionId !== instance.definitionId ||
      ids.has(result.id) ||
      result.status !== 'active'
    )
      throw new Error('Executor result identity or status mismatch');
    ids.add(result.id);
    const document = dataset.intelligence.find((d) => d.id === result.documentId);
    if (
      !document ||
      result.id !== analysisIdentity(instance, document, result.vesselId ?? result.mmsi)
    )
      throw new Error('Executor result must use the instance-scoped analysis identity');
    if (
      !result.evidence.ais.every((p) => isDeepStrictEqual(positions.get(p.recordId), p)) ||
      !result.evidence.documents.every((d) => isDeepStrictEqual(documents.get(d.id), d))
    )
      throw new Error('Executor evidence must reference exact input snapshots');
  }
  return response.results as AnalysisResult[];
}
