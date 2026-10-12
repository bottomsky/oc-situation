import type { IntelligenceGeometry } from '@ais/contracts';
import { GeometrySchema } from '@ais/contracts';
export type EditableGeometry = Extract<
  IntelligenceGeometry,
  { type: 'Point' | 'LineString' | 'Polygon' }
>;
function checked(value: unknown): IntelligenceGeometry {
  const geometry = GeometrySchema.parse(value);
  let count = 0;
  function visit(coordinates: unknown) {
    if (!Array.isArray(coordinates)) return;
    if (typeof coordinates[0] === 'number') {
      if (++count > 10000) throw new Error('单个绘制草稿最多 10000 个顶点');
    } else for (const child of coordinates) visit(child);
  }
  visit(geometry.coordinates);
  return geometry;
}
export function splitEditableGeometry(value: unknown): EditableGeometry[] {
  const geometry = checked(value);
  switch (geometry.type) {
    case 'MultiPoint':
      return geometry.coordinates.map((coordinates) => ({ type: 'Point', coordinates }));
    case 'MultiLineString':
      return geometry.coordinates.map((coordinates) => ({ type: 'LineString', coordinates }));
    case 'MultiPolygon':
      return geometry.coordinates.map((coordinates) => ({ type: 'Polygon', coordinates }));
    default:
      return [geometry];
  }
}
export function combineEditableGeometry(
  family: IntelligenceGeometry['type'],
  parts: EditableGeometry[],
): IntelligenceGeometry {
  if (!parts.length) throw new Error('绘制草稿没有几何');
  switch (family) {
    case 'MultiPoint':
      return checked({
        type: family,
        coordinates: parts.map((p) => {
          if (p.type !== 'Point') throw new Error('点几何不可混入其他类型');
          return p.coordinates;
        }),
      });
    case 'MultiLineString':
      return checked({
        type: family,
        coordinates: parts.map((p) => {
          if (p.type !== 'LineString') throw new Error('线几何不可混入其他类型');
          return p.coordinates;
        }),
      });
    case 'MultiPolygon':
      return checked({
        type: family,
        coordinates: parts.map((p) => {
          if (p.type !== 'Polygon') throw new Error('面几何不可混入其他类型');
          return p.coordinates;
        }),
      });
    default:
      if (parts.length !== 1 || parts[0]?.type !== family)
        throw new Error('单几何须保持唯一组件与原几何类型');
      return checked(parts[0]);
  }
}
