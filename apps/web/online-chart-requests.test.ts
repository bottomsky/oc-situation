import { expect, it, vi } from 'vitest';
import type { AddProtocolAction } from 'maplibre-gl';
import { createOnlineChartRequests } from './app/utils/onlineChartRequests';
import { addOnlineChartStyle, readOnlineChartConfig } from './app/utils/onlineChartStyle';
import { createManifestStyle } from './app/utils/chartPresentation';

function fixture(fetcher: typeof fetch) {
  const handlers = new Map<string, AddProtocolAction>();
  const registry = {
    addProtocol: vi.fn((name: string, handler: AddProtocolAction) => handlers.set(name, handler)),
    removeProtocol: vi.fn((name: string) => handlers.delete(name)),
  };
  const requests = createOnlineChartRequests(registry, { fetch: fetcher });
  const handler = [...handlers.values()][0]!;
  return { handlers, registry, requests, handler };
}

it('HTTP404和500转为无status普通Error，混合成功资源不能吞掉失败', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(new Uint8Array([1, 2])))
    .mockResolvedValueOnce(new Response('', { status: 404 }))
    .mockResolvedValueOnce(new Response('', { status: 500 }));
  const f = fixture(fetcher);
  const url = f.requests.wrapUrl('https://tiles.fixture/0/0/0.pbf');
  expect(
    new Uint8Array(
      (await f.handler({ url, type: 'arrayBuffer' }, new AbortController())).data as ArrayBuffer,
    ),
  ).toEqual(new Uint8Array([1, 2]));
  for (const status of [404, 500]) {
    const error = await f
      .handler({ url, type: 'arrayBuffer' }, new AbortController())
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty('status');
    expect((error as Error).message).toContain(String(status));
  }
  f.requests.dispose();
});

it('TileJSON重写瓦片模板，原HTTPS请求保留替换参数、缓存响应头与默认缓存行为', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tilejson: '3.0.0',
          tiles: ['../tiles/{z}/{x}/{y}.pbf?key=a'],
          minzoom: 0,
          maxzoom: 14,
        }),
        {
          headers: {
            'cache-control': 'public,max-age=3600',
            expires: 'Wed, 01 Jan 2030 00:00:00 GMT',
          },
        },
      ),
    )
    .mockResolvedValueOnce(new Response(new Uint8Array([3])));
  const f = fixture(fetcher);
  const controller = new AbortController();
  const metadata = await f.handler(
    { url: f.requests.wrapUrl('https://tiles.fixture/meta/source.json'), type: 'json' },
    controller,
  );
  expect(metadata).toMatchObject({
    cacheControl: 'public,max-age=3600',
    expires: 'Wed, 01 Jan 2030 00:00:00 GMT',
  });
  const tiles = (metadata.data as { tiles: string[] }).tiles;
  expect(tiles[0]).toContain('{z}');
  const tile = tiles[0]!.replace('{z}', '5').replace('{x}', '20').replace('{y}', '10');
  await f.handler({ url: tile, type: 'arrayBuffer' }, controller);
  expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
    'https://tiles.fixture/meta/source.json',
    'https://tiles.fixture/tiles/5/20/10.pbf?key=a',
  ]);
  for (const call of fetcher.mock.calls) expect(call[1]).toEqual({ signal: controller.signal });
  f.requests.dispose();
});

it('每个Map独立协议，仅包裹在线源，不改变配置及业务source', () => {
  const a = fixture(vi.fn<typeof fetch>());
  const b = fixture(vi.fn<typeof fetch>());
  const style = addOnlineChartStyle(createManifestStyle('dark'), 'dark', readOnlineChartConfig());
  const wrapped = a.requests.wrapStyle(style);
  expect(wrapped.sources['online-osm']).not.toEqual(style.sources['online-osm']);
  expect(wrapped.sources['local-land']).toBe(style.sources['local-land']);
  expect(a.requests.wrapUrl('https://tiles.fixture/a')).not.toBe(
    b.requests.wrapUrl('https://tiles.fixture/a'),
  );
  a.requests.dispose();
  a.requests.dispose();
  expect(a.registry.removeProtocol).toHaveBeenCalledOnce();
  expect(b.handlers.size).toBe(1);
  b.requests.dispose();
});

it('abort透传原请求，dispose终止进行中的请求并注销协议', async () => {
  let signal: AbortSignal | undefined;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        signal = init?.signal ?? undefined;
        signal?.addEventListener('abort', () => reject(signal!.reason));
      }),
  );
  const f = fixture(fetcher);
  const pending = f
    .handler(
      { url: f.requests.wrapUrl('https://tiles.fixture/a.png'), type: 'image' },
      new AbortController(),
    )
    .catch((error: unknown) => error);
  f.requests.dispose();
  expect(signal?.aborted).toBe(true);
  expect(await pending).toHaveProperty('name', 'AbortError');
  expect(f.handlers.size).toBe(0);
});

it('拒绝TileJSON中的非HTTPS或凭证URL，不把错误响应当成功瓦片', async () => {
  const f = fixture(
    vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ tiles: ['http://unsafe.fixture/{z}/{x}/{y}'] })),
      ),
  );
  await expect(
    f.handler(
      { url: f.requests.wrapUrl('https://tiles.fixture/a.json'), type: 'json' },
      new AbortController(),
    ),
  ).rejects.toThrow('地址无效');
  expect(() => f.requests.wrapUrl('https://user:secret@tiles.fixture/a')).toThrow();
  f.requests.dispose();
});
