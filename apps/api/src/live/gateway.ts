import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { MapResponse } from '@ais/contracts';
import { parseMapQuery } from '../map/query';

type MapItem = MapResponse['items'][number];
export interface LiveFeedItem {
  cursor: string;
  resultId: string;
  revision: number;
}
export interface LiveGatewayOptions {
  origins: string[];
  authenticate: (token: string | undefined) => Promise<unknown>;
  readFeed: (cursor: string) => Promise<{ items: LiveFeedItem[]; nextCursor: string }>;
  readMap: (query: Record<string, unknown>) => Promise<MapResponse>;
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

export function attachLiveGateway(server: Server, options: LiveGatewayOptions) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const timers = new Set<ReturnType<typeof setInterval>>();
  let closing = false;
  let pending = 0;
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
        () => {
          if (closing || socket.destroyed) return rejectUpgrade(socket, 503);
          wss.handleUpgrade(request, socket, head, (ws) => {
            let cursor = initialCursor;
            let busy = false;
            let authenticatedAt = Date.now();
            let viewport: { version: number; query: Record<string, unknown> } | undefined;
            let previous: MapResponse | undefined;
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
                  return;
                }
                if (
                  message.type !== 'viewport' ||
                  !Number.isSafeInteger(message.version) ||
                  message.version! < 0 ||
                  !message.query
                )
                  throw new Error('Invalid subscription');
                parseMapQuery(message.query);
                if (viewport && message.version! <= viewport.version) return;
                viewport = { version: message.version!, query: message.query };
                previous = undefined;
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
                    await options.authenticate(token);
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
                const page = await options.readFeed(cursor);
                for (const item of page.items) {
                  if (!send({ type: 'analysis.updated', ...item })) return;
                  cursor = item.cursor;
                }
                if (!page.items.length) cursor = page.nextCursor;
                const current = viewport;
                if (current && Date.now() - lastViewport >= (options.intervalMs ?? 2000)) {
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
                send({ type: 'error', code: 'LIVE_TEMPORARILY_UNAVAILABLE' });
              } finally {
                busy = false;
              }
            }
            const timer = setInterval(() => void tick(), options.intervalMs ?? 2000);
            timer.unref();
            timers.add(timer);
            ws.once('close', () => {
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
