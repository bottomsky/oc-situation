import { describe, expect, it } from 'vitest';
import type { AgentSelection, AgentTask } from '../contracts/agent';
import type { AgentAccountMemoryEntry, AgentMemorySnapshot } from '../contracts/agent-memory';
import type { FocusTargetRef } from '../contracts/agent-focus';
import { dynamicTaskSelection } from './agent-dynamic-routing';
import { deriveAgentIntent, requiredAgentInputFields } from './agent-intents';
import { deriveMemoryIntent, resolveMemorySelection, type ReferentMemory } from './agent-memory';
import { boundedMemoryProjection } from './agent-memory-context';
import { namedMemoryFromInstruction, resolveNamedMemory } from './agent-memory-named';
import { memoryObjectsFromTask } from './agent-memory-result';

const now = new Date('2026-10-18T02:00:00.000Z');
const oldMmsi = '413000001';
const newMmsi = '413999999';
const circle = {
  kind: 'circle' as const,
  center: [121.5, 31.2] as [number, number],
  radiusMeters: 5000,
};
const oldBbox: [number, number, number, number] = [110, 20, 120, 30];
const movedBbox: [number, number, number, number] = [0, 0, 1, 1];
const entry = (key: string, value: AgentAccountMemoryEntry['value']): AgentAccountMemoryEntry => ({
  id: key,
  category:
    value && typeof value === 'object' && 'kind' in value ? String(value.kind) : 'user_preference',
  key,
  value,
  status: 'active',
  source: {},
  revision: 1,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
  expiresAt: null,
});
const memory = (selection: AgentSelection = { bbox: oldBbox }): ReferentMemory => ({
  objectSets: [
    {
      id: 'previous-query',
      label: '上一轮完整船舶集合',
      kind: 'vessels',
      turnSeq: 2,
      members: [{ kind: 'vessel', mmsi: oldMmsi }],
      targets: [{ kind: 'vessel', id: oldMmsi }],
      source: {},
      querySucceeded: true,
      uiSucceeded: false,
    },
  ],
  conditions: { intent: 'vessel_list', selection },
});

describe('memory acceptance across local extraction and identity resolution', () => {
  it('combines a fresh explicit MMSI with the explicitly named account region', () => {
    const goal = `研究区内查询船舶${newMmsi}的信息`;
    const named = resolveNamedMemory(goal, dynamicTaskSelection(goal, {}, now), [
      entry('研究区', { kind: 'named_region', region: { kind: 'bbox', bbox: oldBbox } }),
    ]);
    const resolved = resolveMemorySelection(goal, named.selection, 'vessel_detail', memory());

    expect(resolved.selection.region).toEqual({ kind: 'bbox', bbox: oldBbox });
    expect(resolved.selection.mmsis).toEqual([newMmsi]);
    expect(resolved.selection.vesselSelector).toEqual({ mmsis: [newMmsi] });
    expect(requiredAgentInputFields(resolved.selection, 'vessel_detail')).toEqual([]);
  });

  it('keeps a fresh ship name and named region when continuing an earlier object query', () => {
    const goal = '继续在研究区高亮船名“NEW SHIP”的船舶';
    const named = resolveNamedMemory(goal, dynamicTaskSelection(goal, {}, now), [
      entry('研究区', { kind: 'named_region', region: circle }),
    ]);
    const resolved = resolveMemorySelection(goal, named.selection, 'vessel_highlights', memory());

    expect(resolved.selection.vesselSelector).toEqual({ query: 'NEW SHIP' });
    expect(resolved.selection.region).toEqual(circle);
    expect(resolved.selection.mmsis).toBeUndefined();
    expect(resolved.selection.focusTargets).toBeUndefined();
  });

  it('replaces a stale viewport with a named circle instead of retaining conflicting scope', () => {
    const resolved = resolveNamedMemory('查询研究区内有多少船', { bbox: movedBbox }, [
      entry('研究区', { kind: 'named_region', region: circle }),
    ]);

    expect(resolved.selection.region).toEqual(circle);
    expect(resolved.selection.bbox).toBeUndefined();
    expect(requiredAgentInputFields(resolved.selection, 'vessel_list')).toEqual([]);
  });

  it.each(['聚焦研究区和备选区', '聚焦北部研究区'])(
    'asks for clarification when the literal names are ambiguous: %s',
    (goal) => {
      const selection = { bbox: movedBbox };
      const names = goal.includes('备选区') ? ['研究区', '备选区'] : ['研究区', '北部研究区'];
      const resolved = resolveNamedMemory(
        goal,
        selection,
        names.map((name, index) =>
          entry(name, {
            kind: 'named_region',
            region: { kind: 'bbox', bbox: index === 0 ? oldBbox : movedBbox },
          }),
        ),
      );

      expect(resolved).toMatchObject({ matched: true, ambiguous: true, selection });
    },
  );

  it('round-trips selected vessels, routes and events through a named target set', () => {
    const targets: FocusTargetRef[] = [
      { kind: 'vessel', id: newMmsi },
      { kind: 'route', id: '11111111-1111-4111-8111-111111111111', revision: 3 },
      { kind: 'event', id: '22222222-2222-4222-8222-222222222222', revision: 4 },
    ];
    const saved = namedMemoryFromInstruction('选中的对象叫联合目标', {
      content: '',
      historyHours: 24,
      mapContext: {
        bbox: movedBbox,
        capturedAt: now.toISOString(),
        selectedMmsis: [newMmsi],
        selectedTargets: targets,
      },
    })!;
    const named = resolveNamedMemory('聚焦联合目标', {}, [entry(saved.key, saved.value)]);
    const resolved = resolveMemorySelection('聚焦联合目标', named.selection, 'map_focus', memory());

    expect(resolved.selection.focusTargets).toEqual(targets);
    expect(resolved.selection.mmsis).toEqual([newMmsi]);
  });

  it('retains all mixed references when current selection overrides an earlier vessel batch', () => {
    const targets: FocusTargetRef[] = [
      { kind: 'vessel', id: newMmsi },
      { kind: 'route', id: 'route-current' },
      { kind: 'event', id: 'event-current' },
    ];
    const resolved = resolveMemorySelection('聚焦这些', {}, 'map_focus', memory(), {
      selectedMmsis: [newMmsi],
      selectedTargets: targets,
    });

    expect(resolved.selection.focusTargets).toEqual(targets);
    expect(resolved.selection.mmsis).toEqual([newMmsi]);
    expect(resolved.source).toBe('submitted');
  });

  it('leaves no replacement object set after a greeting and keeps the previous batch available', () => {
    const session = memory();
    const intent = deriveMemoryIntent('你好', deriveAgentIntent('你好'), session);
    const greeting = memoryObjectsFromTask(
      {
        task: { id: 'greeting-task', intent: intent.intent, selection: {} } as AgentTask,
        steps: [],
      },
      3,
      true,
    );

    expect(intent.intent).toBe('conversation');
    expect(greeting.objectSets).toEqual([]);
    expect(greeting.references).toEqual([]);
    expect(resolveMemorySelection('聚焦', {}, 'map_focus', session).selection.focusTargets).toEqual(
      [{ kind: 'vessel', id: oldMmsi }],
    );
  });

  it('excludes named account objects when reads are disabled while retaining session semantics', () => {
    const snapshot: AgentMemorySnapshot = {
      taskId: 'task',
      inputRevision: 0,
      turnSeq: 3,
      settingsGeneration: 1,
      accountRevision: 1,
      sessionRevision: 1,
      sessionGeneration: 0,
      settings: { readEnabled: false, proposalsEnabled: true, generation: 1, revision: 1 },
      session: {
        sessionId: 'session',
        revision: 1,
        turnSeq: 2,
        generation: 0,
        objectSets: memory().objectSets,
        conditions: {},
        references: [],
        summary: '此前查询过北部湾油轮',
        updatedAt: now.toISOString(),
      },
      account: [
        entry('保密船队', { kind: 'named_targets', targets: [{ kind: 'vessel', id: newMmsi }] }),
      ],
      recentTurns: [{ role: 'user', content: '北部湾油轮查询', taskId: 'previous' }],
    };
    const projected = boundedMemoryProjection(snapshot, '聚焦保密船队');

    expect(projected.preferences).toEqual([]);
    expect(projected.summary).toContain('北部湾油轮');
    expect(projected.objects).toEqual([
      { kind: 'vessels', count: 1, querySucceeded: true, uiSucceeded: false },
    ]);
    expect(JSON.stringify(projected)).not.toMatch(/保密船队|413999999/);
  });

  it('inherits a previous circle as executable scope after the viewport has moved', () => {
    const resolved = resolveMemorySelection(
      '统计刚才这批有多少船',
      { bbox: movedBbox },
      'vessel_list',
      memory({ region: circle, filters: { hours: 6 } }),
    );

    expect(resolved.selection.region).toEqual(circle);
    expect(resolved.selection.bbox).toBeUndefined();
    expect(resolved.selection.filters).toEqual({ hours: 6 });
    expect(requiredAgentInputFields(resolved.selection, 'vessel_list')).toEqual([]);
  });
});
