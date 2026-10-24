import type { Bbox, MapCameraRequest, MapCameraResult } from '@ais/contracts';
import type { EaseToOptions, FitBoundsOptions, LngLatBoundsLike } from 'maplibre-gl';
import { heatmapViewportBounds } from './heatmapMap';

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  side?: 'left' | 'right' | 'bottom';
  gap?: number;
}
export interface CameraPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
interface CameraOverlayNode {
  getClientRects(): { length: number };
  getBoundingClientRect(): Rect;
  closest(selector: string): { getAttribute(name: string): string | null } | null;
  classList: { contains(name: string): boolean };
}

/** Fullscreen keeps outside layout boxes alive; only its descendants obstruct its map. */
export function cameraOverlayRects<T extends CameraOverlayNode>(
  elements: Iterable<T>,
  options: { fullscreen?: { contains(element: T): boolean } | null; visible(element: T): boolean },
): Rect[] {
  return [...elements]
    .filter(
      (element) =>
        (!options.fullscreen || options.fullscreen.contains(element)) &&
        !!element.getClientRects().length &&
        options.visible(element) &&
        !element.closest('[inert]'),
    )
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const explicit = element.closest('[data-side]')?.getAttribute('data-side');
      const dock = element.classList.contains('chart-agent-dock');
      const side = dock
        ? 'bottom'
        : explicit === 'left' || explicit === 'right'
          ? explicit
          : element.closest('#chart-left-slot')
            ? 'left'
            : element.closest('#chart-right-slot')
              ? 'right'
              : undefined;
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        side,
        gap: dock ? 8 : undefined,
      };
    });
}
type CameraErrorCode =
  'STATE_CONFLICT' | 'UNAVAILABLE' | 'EXECUTION_FAILED' | 'POSTCONDITION_FAILED';
export function cameraError(message: string, code: CameraErrorCode) {
  return Object.assign(new Error(message), { code });
}
export function cameraBounds([w, s, e, n]: Bbox): [[number, number], [number, number]] {
  return [
    [w, s],
    [w > e ? e + 360 : e, n],
  ];
}

// Explicit drawer identity wins over geometry: a wide right drawer can cross the midpoint.
export function cameraPadding(view: Rect, overlays: Rect[]): CameraPadding {
  const width = view.right - view.left;
  const height = view.bottom - view.top;
  const verticalGap = height < 360 ? 8 : 24;
  const padding = { top: verticalGap, right: 24, bottom: verticalGap, left: 24 };
  for (const rect of overlays) {
    const w = Math.min(rect.right, view.right) - Math.max(rect.left, view.left);
    const h = Math.min(rect.bottom, view.bottom) - Math.max(rect.top, view.top);
    const gap = rect.gap ?? verticalGap;
    if (w <= 0 || h <= 0) continue;
    if (rect.side === 'bottom')
      padding.bottom = Math.max(padding.bottom, view.bottom - rect.top + gap);
    else if (rect.side === 'left')
      padding.left = Math.max(padding.left, rect.right - view.left + 24);
    else if (rect.side === 'right')
      padding.right = Math.max(padding.right, view.right - rect.left + 24);
    else if (h >= height * 0.45 && rect.left <= view.left + width * 0.45)
      padding.left = Math.max(padding.left, rect.right - view.left + 24);
    else if (h >= height * 0.45 && rect.right >= view.right - width * 0.45)
      padding.right = Math.max(padding.right, view.right - rect.left + 24);
    else if (w >= width * 0.25 && rect.top <= view.top + height * 0.25)
      padding.top = Math.max(padding.top, rect.bottom - view.top + gap);
    else if (w >= width * 0.25 && rect.bottom >= view.bottom - height * 0.3)
      padding.bottom = Math.max(padding.bottom, view.bottom - rect.top + gap);
  }
  const constrain = (a: 'left' | 'top', b: 'right' | 'bottom', size: number) => {
    // Preserve the actual obstruction instead of inventing 160px beneath a drawer.
    // One remaining pixel keeps MapLibre padding mathematically valid when fully covered.
    const max = Math.max(0, size - 1);
    const sum = padding[a] + padding[b];
    if (sum > max) {
      padding[a] *= max / sum;
      padding[b] *= max / sum;
    }
  };
  constrain('left', 'right', width);
  constrain('top', 'bottom', height);
  return padding;
}

interface CameraMap {
  on(name: 'moveend', listener: (event: { chartCameraCommandId?: string }) => void): unknown;
  off(name: 'moveend', listener: (event: { chartCameraCommandId?: string }) => void): unknown;
  stop(): unknown;
  setPadding(padding: CameraPadding): unknown;
  easeTo(options: EaseToOptions, eventData: { chartCameraCommandId: string }): unknown;
  fitBounds(
    bounds: LngLatBoundsLike,
    options: FitBoundsOptions,
    eventData: { chartCameraCommandId: string },
  ): unknown;
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  getBounds(): { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number };
}
export function createMapCamera(
  map: CameraMap,
  padding: () => CameraPadding,
  reducedMotion: () => boolean,
) {
  let cancel: ((reason: string, code?: CameraErrorCode) => void) | undefined;
  let evidence: MapCameraResult | null = null;
  let disposed = false;
  const state = (commandId: string): MapCameraResult => {
    const center = map.getCenter();
    const b = map.getBounds();
    return {
      commandId,
      center: [((((center.lng + 180) % 360) + 360) % 360) - 180, center.lat],
      zoom: map.getZoom(),
      bbox: heatmapViewportBounds(b.getWest(), b.getSouth(), b.getEast(), b.getNorth()),
    };
  };
  return {
    current: () => evidence,
    state: (): Omit<MapCameraResult, 'commandId'> => {
      const { commandId: _commandId, ...actual } = state('');
      return actual;
    },
    invalidate() {
      evidence = null;
    },
    interrupt() {
      evidence = null;
      cancel?.('用户已接管镜头', 'STATE_CONFLICT');
    },
    apply(
      request: MapCameraRequest,
      commandId: string,
      signal?: AbortSignal,
    ): Promise<MapCameraResult> {
      cancel?.('镜头操作已被更新', 'STATE_CONFLICT');
      evidence = null;
      if (disposed) return Promise.reject(cameraError('镜头已卸载', 'UNAVAILABLE'));
      if (signal?.aborted) return Promise.reject(cameraError('镜头操作已取消', 'STATE_CONFLICT'));
      map.stop();
      const startingCenter = map.getCenter();
      const startingZoom = map.getZoom();
      // MapLibre 6.11 keeps easeTo padding on its transform; fitBounds then
      // subtracts both that retained padding and this command's fitting inset.
      // Reset before calculating the next camera and before its move listener.
      map.setPadding({ top: 0, right: 0, bottom: 0, left: 0 });
      return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          clearTimeout(timer);
          map.off('moveend', complete);
          signal?.removeEventListener('abort', aborted);
          cancel = undefined;
        };
        const complete = (event: { chartCameraCommandId?: string }) => {
          if (settled || event.chartCameraCommandId !== commandId) return;
          settled = true;
          cleanup();
          evidence = state(commandId);
          resolve(evidence);
        };
        const fail = (reason: string, code: CameraErrorCode = 'EXECUTION_FAILED') => {
          if (settled) return;
          settled = true;
          cleanup();
          map.stop();
          reject(cameraError(reason, code));
        };
        const aborted = () => fail('镜头操作已取消', 'STATE_CONFLICT');
        cancel = fail;
        signal?.addEventListener('abort', aborted, { once: true });
        map.on('moveend', complete);
        const timer = setTimeout(
          () => fail('镜头移动未在期限内完成', 'POSTCONDITION_FAILED'),
          5000,
        );
        const options = {
          duration: reducedMotion() ? 0 : 800,
          padding: padding(),
        };
        try {
          if (request.mode === 'bounds')
            map.fitBounds(
              cameraBounds(request.bbox),
              {
                ...options,
                maxZoom: request.maxZoom ?? 10,
              },
              { chartCameraCommandId: commandId },
            );
          else
            map.easeTo(
              {
                ...options,
                center:
                  request.mode === 'point'
                    ? request.center
                    : [startingCenter.lng, startingCenter.lat],
                zoom: Math.max(
                  0,
                  Math.min(
                    22,
                    request.mode === 'point'
                      ? (request.zoom ?? 10)
                      : (request.zoom ?? startingZoom + (request.zoomDelta ?? 0)),
                  ),
                ),
              },
              { chartCameraCommandId: commandId },
            );
        } catch (error) {
          fail(error instanceof Error ? error.message : '镜头操作失败');
        }
      });
    },
    dispose() {
      disposed = true;
      evidence = null;
      cancel?.('镜头已卸载', 'STATE_CONFLICT');
    },
  };
}
