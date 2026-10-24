import type { AddProtocolAction, StyleSpecification } from 'maplibre-gl';
import { ONLINE_SEAMARK_SOURCE_ID, ONLINE_VECTOR_SOURCE_ID } from './onlineChartStyle';

interface ProtocolRegistry {
  addProtocol(name: string, handler: AddProtocolAction): void;
  removeProtocol(name: string): void;
}

/** Scope the two online resources to one map and preserve normal browser HTTP caching. */
export function createOnlineChartRequests(
  registry: ProtocolRegistry,
  options: { fetch?: typeof fetch } = {},
) {
  const scheme = `online-chart-${crypto.randomUUID()}`;
  const prefix = `${scheme}://`;
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  const active = new Set<AbortController>();
  let disposed = false;
  function wrapUrl(url: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
      throw new Error('在线图源地址无效');
    // MapLibre substitutes these template tokens before invoking the protocol.
    return `${prefix}${encodeURIComponent(url).replaceAll('%7B', '{').replaceAll('%7D', '}')}`;
  }
  const handler: AddProtocolAction = async (params, controller) => {
    if (disposed) throw new Error('在线图源请求已释放');
    const url = decodeURIComponent(params.url.slice(prefix.length));
    wrapUrl(url);
    active.add(controller);
    try {
      const response = await request(url, { signal: controller.signal });
      // A plain Error deliberately has no status=404: MapLibre treats that status
      // as an empty vector tile instead of a failed source in version 6.11.2.
      if (!response.ok) throw new Error(`在线图源请求失败（HTTP ${response.status}）`);
      let data: object | ArrayBuffer;
      if (params.type === 'json') {
        const json = (await response.json()) as Record<string, unknown>;
        if (!Array.isArray(json.tiles) || !json.tiles.every((tile) => typeof tile === 'string'))
          throw new Error('在线图源元数据缺少瓦片地址');
        data = {
          ...json,
          tiles: json.tiles.map((tile: string) =>
            wrapUrl(new URL(tile, url).href.replaceAll('%7B', '{').replaceAll('%7D', '}')),
          ),
        };
      } else data = await response.arrayBuffer();
      controller.signal.throwIfAborted();
      return {
        data,
        cacheControl: response.headers.get('cache-control') ?? undefined,
        expires: response.headers.get('expires') ?? undefined,
      };
    } finally {
      active.delete(controller);
    }
  };
  registry.addProtocol(scheme, handler);
  return {
    wrapUrl,
    wrapStyle(style: StyleSpecification): StyleSpecification {
      const sources = { ...style.sources };
      const vector = sources[ONLINE_VECTOR_SOURCE_ID];
      if (vector?.type === 'vector' && vector.url)
        sources[ONLINE_VECTOR_SOURCE_ID] = { ...vector, url: wrapUrl(vector.url) };
      const raster = sources[ONLINE_SEAMARK_SOURCE_ID];
      if (raster?.type === 'raster' && raster.tiles)
        sources[ONLINE_SEAMARK_SOURCE_ID] = { ...raster, tiles: raster.tiles.map(wrapUrl) };
      return { ...style, sources };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const controller of active) controller.abort();
      active.clear();
      registry.removeProtocol(scheme);
    },
  };
}
