/** Complete pages replace the visible set atomically; deltas require a contiguous baseline. */
export interface PointPage<T> {
  snapshotId: string;
  sequence: number;
  items: T[];
  total: number;
  complete: boolean;
  nextCursor: string | null;
  generatedAt: string;
  expiresAt: string;
}
export function createPointSnapshot<T extends { mmsi: string }>() {
  let visible = new Map<string, T>();
  const pending = new Map<string, T>();
  let pendingId = '';
  let currentId = '';
  let sequence = 0;
  let pendingTotal = 0;
  let pendingSequence = 0;
  let receivedFinal = false;
  const retired = new Set<string>();
  return {
    begin() {
      if (pendingId) retired.add(pendingId);
      pending.clear();
      pendingId = '';
      receivedFinal = false;
    },
    items: () => [...visible.values()],
    accept(page: PointPage<T>) {
      if (retired.has(page.snapshotId) || page.snapshotId === currentId) return null;
      if (pendingId !== page.snapshotId) {
        if (pendingId) retired.add(pendingId);
        pending.clear();
        pendingId = page.snapshotId;
        pendingTotal = page.total;
        pendingSequence = page.sequence;
        receivedFinal = false;
      }
      if (page.total !== pendingTotal || page.sequence !== pendingSequence)
        throw new Error('船位快照分页元数据不一致');
      for (const point of page.items) pending.set(point.mmsi, point);
      receivedFinal ||= page.complete;
      if (pending.size > pendingTotal) throw new Error('船位快照数量超过声明总数');
      if (!receivedFinal || pending.size !== pendingTotal) return null;
      visible = new Map(pending);
      if (currentId) retired.add(currentId);
      currentId = page.snapshotId;
      sequence = page.sequence;
      pending.clear();
      pendingId = '';
      return [...visible.values()];
    },
    delta(delta: { snapshotId: string; sequence: number; upsert: T[]; remove: string[] }) {
      if (delta.snapshotId !== currentId) return false;
      if (delta.sequence <= sequence) return true;
      if (delta.sequence !== sequence + 1) return false;
      for (const id of delta.remove) visible.delete(id);
      for (const point of delta.upsert) visible.set(point.mmsi, point);
      sequence = delta.sequence;
      return true;
    },
  };
}
