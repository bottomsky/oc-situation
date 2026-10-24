import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { MapResponse } from '@ais/contracts';
import { parseMapQuery } from '../map/query';
import { randomUUID } from 'node:crypto';
import {
  MAP_POINT_MAX_POINTS,
  MAP_POINT_PAGE_SIZE,
  type MapPointReadResult,
} from '../../../../packages/contracts/map-snapshot';
import { MapPointSnapshotError } from '../../../../packages/infrastructure/map-snapshots';

type MapItem = MapResponse['items'][number];
export interface LiveFeedItem {
  cursor: string;
  resultId: string;
  revision: number;
}
export interface LiveGatewayOptions {
  origins: string[];
  authenticate: (token: string | undefined) => Promise<unknown>;
  readFeed: (
    cursor: string,
    ownerId?: string,
  ) => Promise<{ items: LiveFeedItem[]; nextCursor: string }>;
  readMap: (query: Record<string, unknown>) => Promise<MapResponse>;
  readMapPoints?: (query: Record<string, unknown>, ownerId: string) => Promise<MapPointReadResult>;
  intervalMs?: number;
  reauthenticateMs?: number;
  onError?: (error: unknown) => void;
}
const itemKey = (item: MapItem) =>
  item.kind === 'point' ? `point:${item.mmsi}` : `cluster:${item.clusterId}`;
export function mapDelta(previous: MapResponse, next: MapResponse) {
  const before = new Map(previous.items.map((item) => [itemKey(item), JSON.stringify(item)]));
  const after = new Set(next.items.map(itemKey));
  return {
    upsert: next.items.filter((item) => before.get(itemKey(item)) !== JSON.stringify(item)),
    remove: [...before.keys()].filter((key) => !after.has(key)),
    total: next.total,
    sampled: next.sampled,
    truncated: next.truncated,
    generatedAt: next.generatedAt,
  };
}
function tokenFrom(request: IncomingMessage) {
  return (request.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('ais_session='))
    ?.slice(12);
}
function rejectUpgrade(socket: Duplex, status: number) {
  socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
function authenticatedOwner(session: unknown) {
  if (!session || typeof session !== 'object') return undefined;
  const identity = session as { id?: unknown; user?: { id?: unknown } };
  const id = identity.user?.id ?? identity.id;
  return typeof id === 'string' && id.length ? id : undefined;
}

export function attachLiveGateway(server: Server, options: LiveGatewayOptions) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const timers = new Set<ReturnType<typeof setInterval>>();
  let closing = false;
  let pending = 0;
  let pointBytes = 0;
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      return rejectUpgrade(socket, 400);
    }
    if (url.pathname !== '/api/v1/live') return rejectUpgrade(socket, 404);
    if (closing || wss.clients.size + pending >= 200) return rejectUpgrade(socket, 503);
    if (!request.headers.origin || !options.origins.includes(request.headers.origin))
      return rejectUpgrade(socket, 403);
    const initialCursor = url.searchParams.get('cursor') ?? '0';
    if (!/^\d{1,19}$/.test(initialCursor) || BigInt(initialCursor) > 9223372036854775807n)
      return rejectUpgrade(socket, 400);
    const token = tokenFrom(request);
    pending++;
    void options
      .authenticate(token)
      .then(
        (session) => {
          if (closing || socket.destroyed) return rejectUpgrade(socket, 503);
          wss.handleUpgrade(request, socket, head, (ws) => {
            let cursor = initialCursor;
            let busy = false;
            let authenticatedAt = Date.now();
            let ownerId = authenticatedOwner(session);
            let viewport:
              { version: number; query: Record<string, unknown>; mode?: 'points' } | undefined;
            let previous: MapResponse | undefined;
            let points:
              | { data: MapPointReadResult; snapshotId: string; sequence: number; bytes: number }
              | undefined;
            const clearPoints = () => {
              pointBytes -= points?.bytes ?? 0;
              points = undefined;
            };
            let alive = true;
            let lastPing = Date.now();
            let lastViewport = 0;
            const send = (data: unknown) => {
              if (ws.readyState !== WebSocket.OPEN) return false;
              if (ws.bufferedAmount > 2 * 1024 * 1024) {
                ws.close(1013, 'Reconnect and resume');
                return false;
              }
              ws.send(JSON.stringify(data));
              return true;
            };
            // Await each chunk's socket write so 100k vessels cannot accumulate unbounded queued frames.
            const sendChunk = (data: unknown) =>
              new Promise<boolean>((resolve) => {
                const payload = JSON.stringify(data);
                if (ws.readyState !== WebSocket.OPEN) return resolve(false);
                if (ws.bufferedAmount + Buffer.byteLength(payload) > 2 * 1024 * 1024) {
                  ws.close(1013, 'Reconnect and resume');
                  return resolve(false);
                }
                ws.send(payload, (error) => resolve(!error));
              });
            ws.on('error', (error) => options.onError?.(error));
            ws.on('pong', () => {
              alive = true;
            });
            ws.on('message', (raw) => {
              try {
                const message = JSON.parse(raw.toString()) as {
                  type?: string;
                  version?: number;
                  query?: Record<string, unknown>;
                };
                if (message.type === 'unsubscribe') {
                  viewport = undefined;
                  previous = undefined;
                  clearPoints();
                  return;
                }
                if (
                  message.type !== 'viewport' ||
                  !Number.isSafeInteger(message.version) ||
                  message.version! < 0 ||
                  !message.query
                )
                  throw new Error('Invalid subscription');
                const { mode, ...query } = message.query;
                if (mode !== undefined && mode !== 'points')
                  throw new Error('Invalid subscription mode');
                parseMapQuery(query);
                if (viewport && message.version! <= viewport.version) return;
                if (mode === 'points' && !ownerId) {
                  send({
                    type: 'error',
                    code: 'AIS_POINTS_UNAUTHORIZED',
                    version: message.version,
                  });
                  return;
                }
                if (mode === 'points' && !options.readMapPoints) {
                  send({ type: 'error', code: 'AIS_POINTS_UNAVAILABLE', version: message.version });
                  return;
                }
                viewport = { version: message.version!, query, mode };
                previous = undefined;
                clearPoints();
                lastViewport = 0;
              } catch {
                send({ type: 'error', code: 'INVALID_SUBSCRIPTION' });
              }
            });
            async function tick() {
              if (busy || ws.readyState !== WebSocket.OPEN) return;
              busy = true;
              try {
                if (Date.now() - authenticatedAt >= (options.reauthenticateMs ?? 30000)) {
                  try {
                    const refreshedOwner = authenticatedOwner(await options.authenticate(token));
                    if (ownerId && refreshedOwner !== ownerId)
                      throw new Error('Session identity changed');
                    ownerId = refreshedOwner;
                    authenticatedAt = Date.now();
                  } catch {
                    ws.close(4401, 'Session expired');
                    return;
                  }
                }
                if (Date.now() - lastPing >= 30000) {
                  if (!alive) {
                    ws.terminate();
                    return;
                  }
                  alive = false;
                  lastPing = Date.now();
                  ws.ping();
                }
                const page = await options.readFeed(cursor, ownerId);
                for (const item of page.items) {
                  if (!send({ type: 'analysis.updated', ...item })) return;
                  cursor = item.cursor;
                }
                if (!page.items.length) cursor = page.nextCursor;
                const current = viewport;
                if (current && Date.now() - lastViewport >= (options.intervalMs ?? 2000)) {
                  if (current.mode === 'points') {
                    if (!ownerId || !options.readMapPoints)
                      throw new MapPointSnapshotError('unauthorized');
                    let data: MapPointReadResult;
                    try {
                      data = await options.readMapPoints(current.query, ownerId);
                    } catch (error) {
                      if (current !== viewport) return;
                      throw error;
                    }
                    if (current !== viewport || ws.readyState !== WebSocket.OPEN) return;
                    if (
                      data.items.length > MAP_POINT_MAX_POINTS ||
                      data.total !== data.items.length
                    )
                      throw new MapPointSnapshotError('data_limit');
                    // Account for UTF-16 strings and parsed object overhead conservatively.
                    const bytes = Buffer.byteLength(JSON.stringify(data)) * 3;
                    if (pointBytes + bytes > 256 * 1024 * 1024) {
                      send({
                        type: 'error',
                        code: 'AIS_POINTS_CAPACITY',
                        version: current.version,
                      });
                      viewport = undefined;
                      clearPoints();
                      return;
                    }
                    // Reserve before the first await: simultaneous sockets share this capacity budget.
                    pointBytes += bytes;
                    let retained = false;
                    try {
                      const before = new Map(
                        points?.data.items.map((item) => [item.mmsi, JSON.stringify(item)]) ?? [],
                      );
                      const after = new Set(data.items.map((item) => item.mmsi));
                      const upsert = data.items.filter(
                        (item) => before.get(item.mmsi) !== JSON.stringify(item),
                      );
                      const remove = [...before.keys()].filter((mmsi) => !after.has(mmsi));
                      const baseline = points;
                      if (!baseline || upsert.length + remove.length > MAP_POINT_PAGE_SIZE) {
                        const snapshotId = randomUUID();
                        const expiresAt = new Date(Date.now() + 60_000).toISOString();
                        for (
                          let offset = 0;
                          offset < Math.max(1, data.items.length);
                          offset += MAP_POINT_PAGE_SIZE
                        ) {
                          if (current !== viewport) return;
                          const end = Math.min(data.items.length, offset + MAP_POINT_PAGE_SIZE);
                          if (
                            !(await sendChunk({
                              type: 'ais.points.snapshot',
                              version: current.version,
                              data: {
                                snapshotId,
                                sequence: 1,
                                items: data.items.slice(offset, end),
                                total: data.total,
                                nextCursor: end < data.total ? String(end) : null,
                                complete: end >= data.total,
                                generatedAt: data.generatedAt,
                                expiresAt,
                              },
                            }))
                          )
                            return;
                        }
                        if (current !== viewport || ws.readyState !== WebSocket.OPEN) return;
                        clearPoints();
                        points = { data, snapshotId, sequence: 1, bytes };
                      } else {
                        if (
                          !(await sendChunk({
                            type: 'ais.points.delta',
                            version: current.version,
                            snapshotId: baseline.snapshotId,
                            sequence: baseline.sequence + 1,
                            upsert,
                            remove,
                            total: data.total,
                            generatedAt: data.generatedAt,
                          }))
                        )
                          return;
                        if (current !== viewport || ws.readyState !== WebSocket.OPEN) return;
                        clearPoints();
                        points = {
                          data,
                          snapshotId: baseline.snapshotId,
                          sequence: baseline.sequence + 1,
                          bytes,
                        };
                      }
                      retained = true;
                    } finally {
                      if (!retained) pointBytes -= bytes;
                    }
                    lastViewport = Date.now();
                    return;
                  }
                  const data = await options.readMap(current.query);
                  if (current !== viewport) return;
                  if (!previous) send({ type: 'ais.snapshot', version: current.version, data });
                  else {
                    const delta = mapDelta(previous, data);
                    // Metadata-only frames keep the freshness indicator accurate.
                    send({ type: 'ais.delta', version: current.version, ...delta });
                  }
                  previous = data;
                  lastViewport = Date.now();
                }
              } catch (error) {
                options.onError?.(error);
                if (viewport?.mode === 'points' && error instanceof MapPointSnapshotError) {
                  send({
                    type: 'error',
                    code: `AIS_POINTS_${error.category.toUpperCase()}`,
                    version: viewport.version,
                  });
                  viewport = undefined;
                  clearPoints();
                } else send({ type: 'error', code: 'LIVE_TEMPORARILY_UNAVAILABLE' });
              } finally {
                busy = false;
              }
            }
            const timer = setInterval(() => void tick(), options.intervalMs ?? 2000);
            timer.unref();
            timers.add(timer);
            ws.once('close', () => {
              viewport = undefined;
              clearPoints();
              clearInterval(timer);
              timers.delete(timer);
            });
            void tick();
          });
        },
        () => rejectUpgrade(socket, 401),
      )
      .finally(() => {
        pending--;
      });
  };
  server.on('upgrade', onUpgrade);
  return {
    async close() {
      closing = true;
      server.off('upgrade', onUpgrade);
      for (const timer of timers) clearInterval(timer);
      timers.clear();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
