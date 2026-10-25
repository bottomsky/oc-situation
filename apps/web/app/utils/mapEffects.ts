import type { IntelligenceGeometry } from '@ais/contracts';
import type {
  MapEffectBounds,
  MapEffectFrame,
  MapEffectIcon,
  MapEffectPoint,
  MapEffectTarget,
} from '../types/mapEffects';

export const MAP_EFFECT_COLOR = '#FFD84D';
export const MAP_EFFECT_DURATION = 1360;
export const MAP_EFFECT_ICONS: readonly MapEffectIcon[] = [
  'vessel',
  'unknown',
  'alert',
  'danger',
  'opportunity',
];

type Vertex = readonly [number, number];
// One local polygon registry serves both SVG and the MapLibre raster glyphs.
// The unknown glyph is rotationally symmetric so it cannot imply a heading.
const glyphs: Record<MapEffectIcon, readonly (readonly Vertex[])[]> = {
  vessel: [
    [
      [18, 3],
      [25, 14],
      [25, 27],
      [22, 32],
      [14, 32],
      [11, 27],
      [11, 14],
    ],
  ],
  unknown: [
    [
      [18, 5],
      [31, 18],
      [18, 31],
      [5, 18],
    ],
  ],
  alert: [
    [
      [15, 4],
      [21, 4],
      [21, 24],
      [15, 24],
    ],
    [
      [15, 28],
      [21, 28],
      [21, 34],
      [15, 34],
    ],
  ],
  danger: [
    [
      [18, 3],
      [33, 31],
      [3, 31],
    ],
    [
      [16, 12],
      [20, 12],
      [20, 23],
      [16, 23],
    ],
    [
      [16, 26],
      [20, 26],
      [20, 29],
      [16, 29],
    ],
  ],
  opportunity: [
    [
      [18, 3],
      [22, 13],
      [33, 18],
      [22, 23],
      [18, 33],
      [14, 23],
      [3, 18],
      [14, 13],
    ],
  ],
};

export function mapEffectGlyphPath(icon: MapEffectIcon): string {
  return glyphs[icon].map((ring) => `M${ring.map(([x, y]) => `${x} ${y}`).join('L')}Z`).join('');
}

export function mapEffectGlyphBearing(icon: MapEffectIcon, bearing = 0): number {
  return icon === 'vessel' ? bearing : 0;
}

export function mapEffectTargetIcon(target: MapEffectTarget): MapEffectIcon {
  return target.icon ?? (target.bearing === undefined ? 'unknown' : 'vessel');
}

/** Shared SVG paint metadata also determines the offscreen raster mask. */
export function mapEffectGlyphPaint(icon: MapEffectIcon) {
  return {
    fill: icon === 'vessel' || icon === 'alert' ? 'currentColor' : 'none',
    stroke: 'currentColor',
    'stroke-width': 1.5,
    'fill-rule': 'evenodd' as const,
  };
}

function pointInside(point: MapEffectPoint, ring: readonly MapEffectPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!,
      b = ring[j]!;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

const glyphImages = new Map<
  string,
  { width: number; height: number; data: Uint8Array<ArrayBuffer> }
>();

/** Rasterize the same outlines as SVG; a separable blur follows the glyph mask. */
export function mapEffectGlyphImage(icon: MapEffectIcon, color = MAP_EFFECT_COLOR) {
  const normalized = /^#[\da-f]{6}$/i.test(color) ? color.toUpperCase() : MAP_EFFECT_COLOR;
  const key = `${icon}:${normalized}`;
  const cached = glyphImages.get(key);
  if (cached) return cached;
  const width = 88;
  const mask = new Float32Array(width * width);
  const rings = glyphs[icon].map((ring) => ring.map(([x, y]) => ({ x: x * 2 + 8, y: y * 2 + 8 })));
  const paint = mapEffectGlyphPaint(icon);
  for (let y = 0; y < width; y++)
    for (let x = 0; x < width; x++) {
      const center = { x: x + 0.5, y: y + 0.5 };
      let distance = Infinity;
      for (const ring of rings)
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i]!,
            b = ring[(i + 1) % ring.length]!;
          const dx = b.x - a.x,
            dy = b.y - a.y;
          const t = Math.max(
            0,
            Math.min(1, ((center.x - a.x) * dx + (center.y - a.y) * dy) / (dx * dx + dy * dy)),
          );
          distance = Math.min(
            distance,
            Math.hypot(center.x - a.x - t * dx, center.y - a.y - t * dy),
          );
        }
      const fill = paint.fill !== 'none' && rings.some((ring) => pointInside(center, ring));
      mask[y * width + x] = fill
        ? 1
        : Math.max(0, Math.min(1, paint['stroke-width'] + 0.5 - distance));
    }
  const blur = (source: Float32Array, horizontal: boolean) => {
    const result = new Float32Array(source.length);
    for (let y = 0; y < width; y++)
      for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let n = -4; n <= 4; n++) {
          const px = horizontal ? x + n : x,
            py = horizontal ? y : y + n;
          if (px >= 0 && py >= 0 && px < width && py < width) sum += source[py * width + px]!;
        }
        result[y * width + x] = sum / 9;
      }
    return result;
  };
  const glow = blur(blur(mask, true), false);
  const data = new Uint8Array(width * width * 4);
  const rgb = [1, 3, 5].map((offset) => parseInt(normalized.slice(offset, offset + 2), 16));
  for (let i = 0; i < mask.length; i++) {
    data.set(rgb, i * 4);
    data[i * 4 + 3] = Math.round(255 * Math.max(mask[i]!, glow[i]! * 0.7));
  }
  const image = { width, height: width, data };
  glyphImages.set(key, image);
  return image;
}

export function mapEffectCornerPath(bounds: MapEffectBounds, corner = 10): string {
  const { left: l, top: t, right: r, bottom: b } = bounds;
  const c = Math.max(0, Math.min(corner, (r - l) / 2, (b - t) / 2));
  return `M${l + c} ${t}H${l}V${t + c}M${r - c} ${t}H${r}V${t + c}M${l} ${b - c}V${b}H${l + c}M${r - c} ${b}H${r}V${b - c}`;
}

export function sampleMapAttention(
  elapsed: number,
  shortSide: number,
): Pick<MapEffectFrame, 'visible' | 'size' | 'phase'> {
  const time = Math.max(0, elapsed);
  if (time >= MAP_EFFECT_DURATION) return { phase: 'done', visible: false, size: 24 };
  if (time < 600) {
    const initial = Math.max(24, shortSide / 3);
    return { phase: 'contract', visible: true, size: 24 + (initial - 24) * (1 - time / 600) ** 3 };
  }
  return {
    phase: 'blink',
    visible: (time >= 720 && time < 920) || (time >= 1040 && time < 1240),
    size: 24,
  };
}

export interface MapEffectProjectionOptions {
  viewport: MapEffectBounds;
  project(point: [number, number], anchorLongitude?: number): MapEffectPoint | null;
  anchorLongitude?: number;
}

function insideViewport(point: MapEffectPoint, bounds: MapEffectBounds): boolean {
  return (
    point.x >= bounds.left &&
    point.x <= bounds.right &&
    point.y >= bounds.top &&
    point.y <= bounds.bottom
  );
}

/** Liang–Barsky clips real segments, including crossings with both endpoints offscreen. */
function clipSegment(
  a: MapEffectPoint,
  b: MapEffectPoint,
  bounds: MapEffectBounds,
): MapEffectPoint[] {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  let start = 0,
    end = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - bounds.left, bounds.right - a.x, a.y - bounds.top, bounds.bottom - a.y];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i]! < 0) return [];
    } else {
      const t = q[i]! / p[i]!;
      if (p[i]! < 0) start = Math.max(start, t);
      else end = Math.min(end, t);
      if (start > end) return [];
    }
  }
  return [
    { x: a.x + start * dx, y: a.y + start * dy },
    { x: a.x + end * dx, y: a.y + end * dy },
  ];
}

function boundsOf(points: MapEffectPoint[]): MapEffectBounds {
  const result = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const p of points) {
    result.left = Math.min(result.left, p.x);
    result.right = Math.max(result.right, p.x);
    result.top = Math.min(result.top, p.y);
    result.bottom = Math.max(result.bottom, p.y);
  }
  return result;
}

/** One projection pass supplies complete focus bounds and the visible selection frame. */
export function projectMapEffectGeometry(
  target: MapEffectTarget,
  options: MapEffectProjectionOptions,
) {
  const full: MapEffectPoint[] = [],
    visible: MapEffectPoint[] = [];
  const paths: string[] = [];
  const viewport = options.viewport;
  let pointOnly = true;
  const projectLine = (coordinates: [number, number][], anchor = options.anchorLongitude) => {
    const reference = anchor ?? coordinates[0]?.[0];
    let longitude = reference;
    return coordinates.map(([lon, lat]) => {
      const unwrapped =
        longitude === undefined ? lon : lon + 360 * Math.round((longitude - lon) / 360);
      longitude = unwrapped;
      const point = options.project([unwrapped, lat], reference);
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
      full.push(point);
      return point;
    });
  };
  const addSegment = (a: MapEffectPoint, b: MapEffectPoint) => {
    visible.push(a, b);
    paths.push(`M${a.x} ${a.y}L${b.x} ${b.y}`);
  };
  const addLine = (line: (MapEffectPoint | null)[], close = false) => {
    for (let i = 0; i < line.length - (close ? 0 : 1); i++) {
      const a = line[i],
        b = line[(i + 1) % line.length];
      if (a && b) {
        const segment = clipSegment(a, b, viewport);
        if (segment.length) addSegment(segment[0]!, segment[1]!);
      }
    }
  };
  const addPolygon = (coordinates: [number, number][][]) => {
    const anchor = options.anchorLongitude ?? coordinates[0]?.[0]?.[0];
    const projected = coordinates.map((ring) => projectLine(ring, anchor));
    if (projected.some((ring) => ring.some((point) => point === null))) return;
    const rings = projected as MapEffectPoint[][];
    const outer = rings[0];
    if (!outer?.length) return;
    const holes = rings.slice(1);
    // Clipped ring edges and filled viewport-edge intervals form the exact visible
    // boundary, including concave polygons and holes crossing the viewport edge.
    const filled = (p: MapEffectPoint) =>
      pointInside(p, outer) && !holes.some((ring) => pointInside(p, ring));
    const endpoints: MapEffectPoint[] = [];
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r]!;
      for (let i = 0; i < ring.length - 1; i++) {
        const segment = clipSegment(ring[i]!, ring[i + 1]!, viewport);
        endpoints.push(...segment);
        if (segment.length && (r === 0 || pointInside(segment[0]!, outer)))
          addSegment(segment[0]!, segment[1]!);
      }
    }
    const corners = [
      { x: viewport.left, y: viewport.top },
      { x: viewport.right, y: viewport.top },
      { x: viewport.right, y: viewport.bottom },
      { x: viewport.left, y: viewport.bottom },
    ];
    for (let i = 0; i < 4; i++) {
      const a = corners[i]!,
        b = corners[(i + 1) % 4]!;
      const horizontal = a.y === b.y;
      const axis = horizontal ? 'x' : 'y';
      const crossAxis = horizontal ? 'y' : 'x';
      const points = [
        a,
        b,
        ...endpoints.filter((p) => Math.abs(p[crossAxis] - a[crossAxis]) < 1e-7),
      ].sort((p, q) => p[axis] - q[axis]);
      for (let j = 0; j < points.length - 1; j++) {
        const p = points[j]!,
          q = points[j + 1]!;
        if (q[axis] - p[axis] > 1e-7 && filled({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }))
          addSegment(p, q);
      }
    }
  };
  const addGeometry = (geometry: IntelligenceGeometry) => {
    if (geometry.type === 'Point' || geometry.type === 'MultiPoint') {
      const points = geometry.type === 'Point' ? [geometry.coordinates] : geometry.coordinates;
      for (const coordinate of points) {
        const p = projectLine([coordinate])[0];
        if (p && insideViewport(p, viewport)) visible.push(p);
      }
      return;
    }
    pointOnly = false;
    if (geometry.type === 'LineString') addLine(projectLine(geometry.coordinates));
    else if (geometry.type === 'MultiLineString')
      geometry.coordinates.forEach((line) => addLine(projectLine(line)));
    else if (geometry.type === 'Polygon') addPolygon(geometry.coordinates);
    else geometry.coordinates.forEach(addPolygon);
  };
  target.geometries.forEach(addGeometry);
  if (!full.length) return null;
  const fullBounds = boundsOf(full);
  const isPoint = pointOnly && full.length === 1;
  const raw = visible.length ? boundsOf(visible) : null;
  const padding = isPoint ? 22 : 8;
  const bounds = raw && {
    left: raw.left - padding,
    top: raw.top - padding,
    right: raw.right + padding,
    bottom: raw.bottom + padding,
  };
  const centerBounds = raw ?? fullBounds;
  return {
    fullBounds,
    bounds,
    isPoint,
    outlinePath: paths.join(''),
    center: {
      x: (centerBounds.left + centerBounds.right) / 2,
      y: (centerBounds.top + centerBounds.bottom) / 2,
    },
  };
}

export function projectMapEffect(target: MapEffectTarget, options: MapEffectProjectionOptions) {
  const projected = projectMapEffectGeometry(target, options);
  return projected?.bounds ? { ...projected, bounds: projected.bounds } : null;
}
