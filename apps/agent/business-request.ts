export * from '../../packages/domain/agent-business';
import { createHash } from 'node:crypto';
export function businessOperationId(
  taskId: string,
  revision: number,
  stepId: string,
  toolId: string,
): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([taskId, revision, stepId, toolId]))
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
