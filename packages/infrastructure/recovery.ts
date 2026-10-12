export function archiveIdentity(
  receivedAt: string,
  streamSequence: number,
): { batchId: string; objectKey: string } {
  const minute = new Date(receivedAt).toISOString().slice(0, 16);
  const shard = Math.floor(streamSequence / 10_000)
    .toString()
    .padStart(6, '0');
  return {
    batchId: `${minute}-${shard}`,
    objectKey: `raw/${minute.replace(/[-T:]/g, '/')}/${shard}.jsonl.gz`,
  };
}
export function busPressure(
  bytes: number,
  limit: number,
  oldestAgeMs: number,
): 'ready' | 'warning' | 'paused' {
  if (bytes >= limit * 0.85 || oldestAgeMs >= 86_400_000) return 'paused';
  if (bytes >= limit * 0.7 || oldestAgeMs >= 3_600_000) return 'warning';
  return 'ready';
}
export function toCamelRow<T = Record<string, unknown>>(row: Record<string, unknown>): T {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value instanceof Date ? value.toISOString() : value,
    ]),
  ) as T;
}
