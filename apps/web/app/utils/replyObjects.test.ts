import { describe, expect, it } from 'vitest';
import type { AgentFocusResult } from '@ais/contracts';
import * as helpers from './replyObjects';
const focus = (patch: Partial<AgentFocusResult> = {}): AgentFocusResult => ({
  kind: 'map_focus',
  sessionId: 'session',
  taskId: 'task',
  inputRevision: 1,
  version: 2,
  targets: [],
  missing: [],
  omittedCount: 0,
  bbox: null,
  displayStatus: 'unlocated',
  cameraPolicy: 'if-needed-once',
  ...patch,
});

describe('回复关联对象', () => {
  it('大对象多段几何只进行有界坐标遍历，同时保留首次顺序与内容去重', () => {
    let coordinateReads = 0;
    const ref = { kind: 'intelligence' as const, id: 'large-notice', revision: 4 };
    const targets = Array.from({ length: 40 }, (_, index) => {
      const coordinates = Array.from({ length: 3000 }, (_, point): [number, number] => [
        index,
        point / 100,
      ]);
      return {
        ref,
        label: '分段通告',
        geometry: {
          type: 'LineString' as const,
          get coordinates() {
            coordinateReads++;
            return coordinates;
          },
        },
      };
    });
    const input = focus({ targets: [...targets, targets[0]!, targets[39]!] });
    const objects = helpers.buildReplyObjects(input);
    expect(objects).toHaveLength(1);
    expect(objects[0]?.geometries).toHaveLength(40);
    expect(objects[0]?.geometries[0]).toBe(targets[0]?.geometry);
    expect(objects[0]?.geometries[39]).toBe(targets[39]?.geometry);
    // Bound the actual input-coordinate reads, rather than a machine-dependent duration.
    expect(coordinateReads).toBeLessThanOrEqual(input.targets.length * 2);
  });
  it('同一版本的多段几何合并为一个对象，未定位引用仍保留且不虚构遗漏对象', () => {
    const ref = { kind: 'intelligence' as const, id: 'notice', revision: 2 };
    const value = focus({
      targets: [
        { ref, label: '施工通告', geometry: { type: 'Point', coordinates: [120, 30] } },
        { ref, label: '施工通告', geometry: { type: 'Point', coordinates: [121, 31] } },
      ],
      missing: [ref, { kind: 'vessel', id: '413123456' }],
      omittedCount: 30,
      displayStatus: 'partial',
    });
    const objects = helpers.buildReplyObjects(value);
    expect(objects).toHaveLength(2);
    expect(objects[0]).toMatchObject({
      label: '施工通告',
      located: true,
      geometries: [
        { type: 'Point', coordinates: [120, 30] },
        { type: 'Point', coordinates: [121, 31] },
      ],
    });
    expect(objects[1]).toMatchObject({
      ref: { kind: 'vessel', id: '413123456' },
      located: false,
      geometries: [],
    });
    expect(objects[1]?.label).toContain('413123456');
    expect(value.targets).toHaveLength(2);
  });
  it('对象身份固定修订和来源任务，空输入保持空清单', () => {
    const objects = helpers.buildReplyObjects(
      focus({
        missing: [
          {
            kind: 'track',
            id: '413123456',
            revision: 1,
            sourceTaskId: '00000000-0000-4000-8000-000000000001',
          },
          {
            kind: 'track',
            id: '413123456',
            revision: 2,
            sourceTaskId: '00000000-0000-4000-8000-000000000001',
          },
          {
            kind: 'track',
            id: '413123456',
            revision: 2,
            sourceTaskId: '00000000-0000-4000-8000-000000000002',
          },
        ],
      }),
    );
    expect(new Set(objects.map((item) => item.key)).size).toBe(3);
    expect(helpers.buildReplyObjects(null)).toEqual([]);
  });
  it('业务类型采用任务意图及真实对象种类，混合对象明确显示多对象研判', () => {
    const vessels =
      helpers.buildReplyObjects(focus({ missing: [{ kind: 'vessel', id: '413123456' }] })) ?? [];
    const mixed =
      helpers.buildReplyObjects(
        focus({
          missing: [
            { kind: 'vessel', id: '413123456' },
            { kind: 'intelligence', id: 'notice' },
          ],
        }),
      ) ?? [];
    expect(helpers.replyBusinessType('vessel_detail', vessels)).toBe('船舶分析');
    expect(helpers.replyBusinessType('map_focus', mixed)).toBe('多对象研判');
    expect(helpers.replyBusinessType('intelligence_search', [])).toBe('情报解读');
    expect(helpers.replyBusinessType(undefined, [])).toBe('智能分析');
  });
  it('对象搜索按名称或标识匹配，类型过滤后每页50个且页码有界', () => {
    const objects =
      helpers.buildReplyObjects(
        focus({
          missing: Array.from({ length: 105 }, (_, i) => ({
            kind: 'vessel' as const,
            id: String(413000000 + i),
          })),
        }),
      ) ?? [];
    const page = helpers.replyObjectsPage(objects, '', 'all', 3);
    expect(page).toMatchObject({ total: 105, page: 3, pages: 3 });
    expect(page.items).toHaveLength(5);
    expect(helpers.replyObjectsPage(objects, '413000003', 'vessel', 9)).toMatchObject({
      total: 1,
      page: 1,
      pages: 1,
    });
    expect(helpers.replyObjectsPage(objects, '', 'intelligence', 9)).toMatchObject({
      total: 0,
      page: 1,
      pages: 1,
      items: [],
    });
  });
  it('长名称提示在狭窄图区右边缘与顶部保持完整容器，不依赖祖先裁切', () => {
    const bounds = { left: 20, top: 160, right: 370, bottom: 550 };
    const result = helpers.placeReplyObjectTooltip(
      bounds,
      { left: 290, top: 180, right: 350, bottom: 205 },
      { width: 300, height: 100 },
    );
    expect(result.left).toBeGreaterThanOrEqual(bounds.left + 12);
    expect(result.left + 300).toBeLessThanOrEqual(bounds.right - 12);
    expect(result.top).toBeGreaterThanOrEqual(205);
    expect(result.top + 100).toBeLessThanOrEqual(bounds.bottom - 12);
    const constrained = helpers.placeReplyObjectTooltip(
      { left: 0, top: 0, right: 176, bottom: 120 },
      { left: 100, top: 70, right: 160, bottom: 90 },
      { width: 300, height: 500 },
    );
    expect(constrained).toMatchObject({ left: 12, top: 12, maxWidth: 152, maxHeight: 96 });
  });
});
