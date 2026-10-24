import { describe, expect, it } from 'vitest';
import { AnalysisResultSchema, CreateTopicInstanceSchema } from './topics';

const at = '2026-10-24T00:00:00.000Z';
const result = {
  id: 'a'.repeat(64),
  instanceId: 'instance',
  definitionId: 'vessel-reachability',
  definitionVersion: '1',
  revision: 1,
  status: 'active',
  kind: 'prediction',
  title: '测试',
  summary: '测试',
  mmsi: '413000001',
  from: at,
  to: at,
  bbox: [-180, -90, 180, 90],
  confidence: 'observation',
  prediction: {
    asOf: at,
    computedAt: at,
    expiresAt: at,
    status: 'insufficient_data',
    modelVersion: 'test',
    latestObservedAt: null,
    inputFingerprint: 'a'.repeat(64),
    landDatasetVersion: null,
    reason: 'test',
    impactsCount: 0,
  },
  artifactRef: { resultId: 'a'.repeat(64), revision: 1 },
  evidence: {
    ais: [],
    documents: [],
    steps: [{ id: 'test', rule: 'test', outcome: 'test', references: [] }],
    limitations: ['AIS不足'],
    parameters: { bbox: [-180, -90, 180, 90] },
    queriedAt: at,
  },
  createdAt: at,
  updatedAt: at,
};
describe('topic prediction compatibility', () => {
  it('accepts document-free prediction diagnostics while requiring documents for old rules', () => {
    expect(AnalysisResultSchema.safeParse(result).success).toBe(true);
    expect(
      AnalysisResultSchema.safeParse({ ...result, kind: 'rule', definitionId: 'port-restriction' })
        .success,
    ).toBe(false);
  });
  it('requires a single vessel for prediction definitions', () => {
    expect(
      CreateTopicInstanceSchema.safeParse({
        definitionId: 'vessel-reachability',
        name: 'test',
        config: { bbox: [-180, -90, 180, 90] },
      }).success,
    ).toBe(false);
    expect(
      CreateTopicInstanceSchema.safeParse({
        definitionId: 'vessel-reachability',
        name: 'test',
        config: { bbox: [-180, -90, 180, 90], mmsi: '413000001' },
      }).success,
    ).toBe(true);
  });
});
