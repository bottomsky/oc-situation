import { describe, it, expect } from 'vitest';
import {
  canOperate,
  trackFrame,
  queryString,
  errorLabel,
  confidenceLabel,
} from './app/utils/display';
it('模型估计、规则匹配与共现观察明确区分', () => {
  expect(confidenceLabel('model-estimate')).toBe('模型估计（未校准）');
  expect(confidenceLabel('rule-match')).toBe('规则匹配');
  expect(confidenceLabel('observation')).toBe('共现观察');
});
import type { PositionObservation, TrackResponse } from '@ais/contracts';
const point = (lon: number): PositionObservation => ({
  schemaVersion: 1,
  cleaningVersion: 1,
  eventId: String(lon),
  captureId: 'raw',
  sourceId: 'fixture',
  sourceKind: 'fixture-http',
  sourcePriority: 100,
  runId: null,
  receivedAt: '2026-10-01T01:00:00Z',
  observedAt: '2026-10-01T00:00:00Z',
  quality: ['synthetic'],
  kind: 'position',
  mmsi: '413000001',
  lat: 20,
  lon,
  sogKnots: null,
  cogDegrees: null,
  headingDegrees: null,
  rotDegPerMinute: null,
  navigationStatus: null,
  receptionType: 'UNKNOWN',
});
describe('Web interaction rules', () => {
  it('shows execution only to operator and administrator', () => {
    expect(canOperate('operator')).toBe(true);
    expect(canOperate('admin')).toBe(true);
    expect(canOperate('viewer')).toBe(false);
    expect(canOperate(undefined)).toBe(false);
  });
  it('plays native API segments without joining a date line or observation gap', () => {
    const track: TrackResponse = {
      mmsi: '413000001',
      from: '',
      to: '',
      total: 3,
      returned: 3,
      sampled: false,
      truncated: false,
      segments: [{ points: [point(179)] }, { points: [point(-179), point(-178)] }],
    };
    expect(trackFrame(track, 1)?.lon).toBe(-179);
    expect(trackFrame(track, 99)?.lon).toBe(-178);
    expect(trackFrame(null, 0)).toBeNull();
  });
  it('omits empty parameters and encodes search input', () => {
    expect(queryString({ query: '船 & 1', cursor: undefined, limit: 20 })).toBe(
      '?query=%E8%88%B9+%26+1&limit=20',
    );
  });
  it('distinguishes permission failure and expired session', () => {
    expect(errorLabel(403)).toContain('权限');
    expect(errorLabel(401)).toContain('登录');
    expect(errorLabel(503)).toContain('服务');
  });
  it('explains login rejection separately from expired session', () => {
    expect(errorLabel(401, '/auth/login')).toContain('用户名或密码');
  });
});
