import type { Bbox, MapCameraRequest } from '@ais/contracts';
import { FOCUS_RESERVATION_GAP, focusTopSpace, type FocusSide } from './focusLayout';
import { MercatorCoordinate } from 'maplibre-gl';
import { cameraBounds, type CameraPadding } from './mapCamera';

export interface FocusCameraEstimate {
  placement: FocusSide;
  zoom: number;
  request: MapCameraRequest;
  cardHeight: number;
  objectMinHeight: number;
  shortHeader: boolean;
  compositionFits: boolean;
}
export interface FocusCameraReservation {
  replyPlacement?: FocusSide;
  cardWidth?: number;
  cardHeight?: number;
  objectMinHeight?: number;
}
export interface FocusCardSize {
  cardWidth: number;
  cardHeight: number;
  objectMinHeight?: number;
  topCardLimit?: number;
}

interface FocusEstimateMap {
  cameraForBounds(
    bounds: [[number, number], [number, number]],
    options: { padding: CameraPadding; maxZoom: number },
  ): { zoom?: number } | undefined;
  getPadding(): Partial<CameraPadding>;
}
interface ViewSize {
  width: number;
  height: number;
}

/** Build fresh insets: a card reservation is never retained across commands. */
export function focusReplyPadding(
  base: CameraPadding,
  view: ViewSize,
  reservation: FocusCameraReservation,
): CameraPadding {
  const padding = { ...base };
  if (reservation.replyPlacement === 'right') {
    padding.right += Math.min(
      (reservation.cardWidth ?? 420) + FOCUS_RESERVATION_GAP,
      Math.max(0, view.width - base.left - base.right - 240),
    );
  } else if (reservation.replyPlacement === 'top') {
    padding.top += Math.min(
      (reservation.cardHeight ?? 360) + FOCUS_RESERVATION_GAP,
      Math.max(0, view.height - base.top - base.bottom - (reservation.objectMinHeight ?? 80)),
    );
  }
  return padding;
}

/**
 * MapLibre's default Mercator fit uses a 512px world and bearing zero. Its public
 * cameraForBounds also subtracts retained transform padding; correct that case
 * analytically rather than mutating the map, using private transforms, or passing
 * negative padding. The real bounds command resets retained padding before fitting.
 */
function mercatorFitZoom(bbox: Bbox, view: ViewSize, padding: CameraPadding) {
  const [[west, south], [east, north]] = cameraBounds(bbox);
  const latitude = (lat: number) => Math.max(-85.0511287798066, Math.min(85.0511287798066, lat));
  const a = MercatorCoordinate.fromLngLat([west, latitude(south)]);
  const b = MercatorCoordinate.fromLngLat([east, latitude(north)]);
  const availableWidth = view.width - padding.left - padding.right;
  const availableHeight = view.height - padding.top - padding.bottom;
  if (availableWidth <= 0 || availableHeight <= 0) return null;
  const x = Math.abs(b.x - a.x),
    y = Math.abs(b.y - a.y);
  return Math.min(
    10,
    Math.log2(
      Math.min(x ? availableWidth / x : Infinity, y ? availableHeight / y : Infinity) / 512,
    ),
  );
}

export function estimateFocusCamera(
  map: FocusEstimateMap,
  bbox: Bbox,
  view: ViewSize,
  base: CameraPadding,
  card: FocusCardSize,
): FocusCameraEstimate | null {
  const retained = map.getPadding();
  const hasRetained = Object.values(retained).some((value) => (value ?? 0) !== 0);
  const topBudget = focusTopSpace(view.height - base.top - base.bottom, card.topCardLimit);
  const estimate = (placement: FocusSide) => {
    const padding = focusReplyPadding(base, view, {
      replyPlacement: placement,
      ...card,
      ...(placement === 'top'
        ? { cardHeight: topBudget.maxHeight, objectMinHeight: topBudget.objectMinHeight }
        : {}),
    });
    if (hasRetained || Math.abs(bbox[1]) > 85.0511287798066 || Math.abs(bbox[3]) > 85.0511287798066)
      return mercatorFitZoom(bbox, view, padding);
    const native = map.cameraForBounds(cameraBounds(bbox), { padding, maxZoom: 10 });
    return native && typeof native.zoom === 'number' && Number.isFinite(native.zoom)
      ? Math.min(10, native.zoom)
      : mercatorFitZoom(bbox, view, padding);
  };
  let placement: FocusSide = 'right';
  let zoom: number | null = null;
  if (view.width - base.left - base.right - card.cardWidth - FOCUS_RESERVATION_GAP >= 240)
    zoom = estimate('right');
  if (zoom === null || zoom < 4) {
    placement = 'top';
    zoom = estimate('top');
  }
  return zoom !== null && Number.isFinite(zoom)
    ? {
        placement,
        zoom,
        request: { mode: 'bounds', bbox, maxZoom: 10 },
        cardHeight: placement === 'top' ? topBudget.maxHeight : card.cardHeight,
        objectMinHeight:
          placement === 'top' ? topBudget.objectMinHeight : (card.objectMinHeight ?? 80),
        shortHeader: placement === 'top' && topBudget.shortHeader,
        compositionFits: placement !== 'top' || topBudget.feasible,
      }
    : null;
}
