import { randomUUID } from 'node:crypto';
import {
  MAP_POINT_MAX_POINTS,
  MAP_POINT_PAGE_SIZE,
  MapPointQuerySchema,
  type MapPointQuery,
  type MapPointReadResult,
  type MapPointSnapshotPage,
} from '../contracts/map-snapshot';
import type { Infrastructure } from './clients';

export type MapPointSnapshotErrorCategory =
  'unauthorized' | 'invalid_input' | 'gone' | 'busy' | 'data_limit' | 'unavailable';
const messages: Record<MapPointSnapshotErrorCategory, string> = {
  unauthorized: '请登录后查询船位。',
  invalid_input: '船位快照查询条件或分页游标无效。',
  gone: '船位快照已失效，请重新加载当前视窗。',
  busy: '船位快照已达到并发或缓存数量上限，请稍后重试。',
  data_limit: '当前视窗船位超过容量上限，请缩小区域或增加筛选条件。',
  unavailable: '船位查询暂时不可用，请稍后重试。',
};
export class MapPointSnapshotError extends Error {
  constructor(readonly category: MapPointSnapshotErrorCategory) {
    super(messages[category]);
  }
}
interface Snapshot extends MapPointReadResult {
  ownerId: string;
  snapshotId: string;
  expiresAt: number;
  bytes: number;
  completed: boolean;
}
interface SnapshotOptions {
  now?: () => number;
  ttlMs?: number;
  maxPoints?: number;
  maxSnapshots?: number;
  maxBytes?: number;
}
type PageRequest =
  | (MapPointQuery & { pageSize?: number })
  | { snapshotId: string; cursor: string; pageSize?: number };

/** Per-process, bounded cache; every page reads the same immutable materialized query result. */
export class MapPointSnapshotService {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly pendingOwners = new Map<string, number>();
  private pending = 0;
  private reads = 0;
  private readonly readerOwners = new Map<string, number>();
  private bytes = 0;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxPoints: number;
  private readonly maxSnapshots: number;
  private readonly maxBytes: number;
  constructor(
    private readonly infra: Infrastructure,
    options: SnapshotOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 60_000;
    this.maxPoints = options.maxPoints ?? MAP_POINT_MAX_POINTS;
    this.maxSnapshots = options.maxSnapshots ?? 20;
    this.maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  }
  private prune() {
    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.expiresAt <= this.now()) {
        this.snapshots.delete(id);
        this.bytes -= snapshot.bytes;
      }
    }
  }
  private owner(ownerId: string) {
    if (!ownerId) throw new MapPointSnapshotError('unauthorized');
  }
  release(ownerId: string, snapshotId: string) {
    this.owner(ownerId);
    this.prune();
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot || snapshot.ownerId !== ownerId) return false;
    this.snapshots.delete(snapshotId);
    this.bytes -= snapshot.bytes;
    return true;
  }
  private reclaimCompleted(ownerId: string) {
    const count = () =>
      [...this.snapshots.values()].filter((snapshot) => snapshot.ownerId === ownerId).length;
    for (const [id, snapshot] of this.snapshots) {
      if (!snapshot.completed) continue;
      const ownerFull = count() + (this.pendingOwners.get(ownerId) ?? 0) >= 2;
      const globalFull = this.snapshots.size + this.pending >= this.maxSnapshots;
      if (!ownerFull && !globalFull) break;
      if (globalFull || snapshot.ownerId === ownerId) {
        this.snapshots.delete(id);
        this.bytes -= snapshot.bytes;
      }
    }
  }
  async read(input: unknown, ownerId: string): Promise<MapPointReadResult> {
    this.owner(ownerId);
    const parsed = MapPointQuerySchema.safeParse(input);
    if (!parsed.success) throw new MapPointSnapshotError('invalid_input');
    if (this.reads >= 8 || (this.readerOwners.get(ownerId) ?? 0) >= 2)
      throw new MapPointSnapshotError('busy');
    const q = parsed.data;
    const regions =
      q.bbox[0] <= q.bbox[2]
        ? [q.bbox]
        : [
            [q.bbox[0], q.bbox[1], 180, q.bbox[3]],
            [-180, q.bbox[1], q.bbox[2], q.bbox[3]],
          ];
    const values: unknown[] = [q.hours, q.sourceId ?? null, q.shipType ?? null];
    const spatial = regions
      .map((region) => {
        const start = values.length;
        values.push(...region);
        return `ST_Intersects(p.location::geometry,ST_MakeEnvelope($${start + 1},$${start + 2},$${start + 3},$${start + 4},4326))`;
      })
      .join(' OR ');
    values.push(this.maxPoints + 1);
    this.reads++;
    this.readerOwners.set(ownerId, (this.readerOwners.get(ownerId) ?? 0) + 1);
    try {
      // A single statement fixes MVCC visibility; an extra row detects overflow without a full COUNT window.
      const result = await this.infra.pool.query(
        `SELECT p.observation FROM positions_latest p JOIN vessels v USING(mmsi) WHERE p.observed_at>=now()-make_interval(hours=>$1) AND ($2::text IS NULL OR p.source_id=$2) AND ($3::integer IS NULL OR v.ship_type=$3) AND (${spatial}) ORDER BY p.mmsi LIMIT $${values.length}`,
        values,
      );
      if (result.rows.length > this.maxPoints) throw new MapPointSnapshotError('data_limit');
      const items = result.rows.map(({ observation: p }) => ({
        kind: 'point' as const,
        mmsi: p.mmsi,
        lat: p.lat,
        lon: p.lon,
        observedAt: p.observedAt,
        sourceId: p.sourceId,
        sogKnots: p.sogKnots ?? null,
        cogDegrees: p.cogDegrees ?? null,
        headingDegrees: p.headingDegrees ?? null,
        quality: p.quality ?? [],
      }));
      return { items, total: items.length, generatedAt: new Date(this.now()).toISOString() };
    } catch (error) {
      if (error instanceof MapPointSnapshotError) throw error;
      throw new MapPointSnapshotError('unavailable');
    } finally {
      this.reads--;
      const remaining = (this.readerOwners.get(ownerId) ?? 1) - 1;
      if (remaining) this.readerOwners.set(ownerId, remaining);
      else this.readerOwners.delete(ownerId);
    }
  }
  async page(ownerId: string, request: PageRequest): Promise<MapPointSnapshotPage> {
    this.owner(ownerId);
    this.prune();
    const size = request.pageSize ?? MAP_POINT_PAGE_SIZE;
    if (!Number.isSafeInteger(size) || size < 1 || size > MAP_POINT_PAGE_SIZE)
      throw new MapPointSnapshotError('invalid_input');
    let snapshot: Snapshot;
    let offset = 0;
    if ('snapshotId' in request) {
      const found = this.snapshots.get(request.snapshotId);
      if (!found || found.ownerId !== ownerId) throw new MapPointSnapshotError('gone');
      if (!/^(0|[1-9]\d{0,8})$/.test(request.cursor))
        throw new MapPointSnapshotError('invalid_input');
      offset = Number(request.cursor);
      if (!Number.isSafeInteger(offset) || offset > found.total)
        throw new MapPointSnapshotError('invalid_input');
      snapshot = found;
    } else {
      this.reclaimCompleted(ownerId);
      const ownerCount = [...this.snapshots.values()].filter(
        (item) => item.ownerId === ownerId,
      ).length;
      if (
        ownerCount + (this.pendingOwners.get(ownerId) ?? 0) >= 2 ||
        this.snapshots.size + this.pending >= this.maxSnapshots
      )
        throw new MapPointSnapshotError('busy');
      this.pending++;
      this.pendingOwners.set(ownerId, (this.pendingOwners.get(ownerId) ?? 0) + 1);
      try {
        const { pageSize: _size, ...query } = request;
        const result = await this.read(query, ownerId);
        const bytes = Buffer.byteLength(JSON.stringify(result)) * 3;
        this.prune();
        if (bytes + this.bytes > this.maxBytes) throw new MapPointSnapshotError('data_limit');
        snapshot = {
          ...result,
          bytes,
          ownerId,
          snapshotId: randomUUID(),
          expiresAt: this.now() + this.ttlMs,
          completed: false,
        };
        this.snapshots.set(snapshot.snapshotId, snapshot);
        this.bytes += bytes;
      } finally {
        this.pending--;
        const remaining = (this.pendingOwners.get(ownerId) ?? 1) - 1;
        if (remaining) this.pendingOwners.set(ownerId, remaining);
        else this.pendingOwners.delete(ownerId);
      }
    }
    const end = Math.min(snapshot.total, offset + size);
    if (end >= snapshot.total) snapshot.completed = true;
    return {
      snapshotId: snapshot.snapshotId,
      sequence: 1,
      items: snapshot.items.slice(offset, end),
      total: snapshot.total,
      nextCursor: end < snapshot.total ? String(end) : null,
      complete: end >= snapshot.total,
      generatedAt: snapshot.generatedAt,
      expiresAt: new Date(snapshot.expiresAt).toISOString(),
    };
  }
}
const services = new WeakMap<Infrastructure, MapPointSnapshotService>();
export function getMapPointSnapshotService(infra: Infrastructure) {
  let service = services.get(infra);
  if (!service) {
    service = new MapPointSnapshotService(infra);
    services.set(infra, service);
  }
  return service;
}
