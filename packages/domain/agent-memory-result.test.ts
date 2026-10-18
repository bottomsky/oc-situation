import { expect, it } from 'vitest';
import { memoryObjectsFromTask } from './agent-memory-result';
import type { AgentTask, AgentQueryResult } from '../contracts/agent';
const task = {
  id: '11111111-1111-4111-8111-111111111111',
  inputRevision: 0,
  intent: 'vessel_highlights',
  selection: { vesselSelector: { model: 'ABC' } },
} as AgentTask;
const query = {
  kind: 'vessel_list',
  inputRevision: 0,
  version: 0,
  total: 2,
  truncated: false,
  items: [{ mmsi: '413000001' }, { mmsi: '413000002' }],
} as AgentQueryResult;
it('records the complete host query snapshot independently of UI success', () => {
  const result = memoryObjectsFromTask(
    { task, steps: [{ key: 'map_vessel_snapshot', output: query }] },
    3,
    false,
  );
  expect(result.objectSets[0]).toMatchObject({
    turnSeq: 3,
    querySucceeded: true,
    uiSucceeded: false,
    members: [
      { kind: 'vessel', mmsi: '413000001' },
      { kind: 'vessel', mmsi: '413000002' },
    ],
  });
});
it('records a truncated display as a reference, preserving its incompleteness', () => {
  const result = memoryObjectsFromTask(
    { task, queryResult: { ...query, truncated: true, total: 1000 }, steps: [] },
    3,
    false,
  );
  expect(result.objectSets).toEqual([]);
  expect(result.references).toContainEqual({
    refType: 'query_result',
    refId: `${task.id}:0`,
    label: '展示2项／匹配1000项，集合未完整保存',
  });
});
it('records an empty query as a real empty identity set', () => {
  const result = memoryObjectsFromTask(
    { task, queryResult: { ...query, total: 0, items: [] }, steps: [] },
    3,
    false,
  );
  expect(result.objectSets).toHaveLength(1);
  expect(result.objectSets[0]?.members).toEqual([]);
});
it('does not replace session object identity for a clear-only action', () => {
  expect(
    memoryObjectsFromTask(
      { task: { ...task, selection: { highlightClear: { mode: 'all' } } }, steps: [] },
      4,
      true,
    ).objectSets,
  ).toEqual([]);
});
