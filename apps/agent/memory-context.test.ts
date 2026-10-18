import { describe, expect, it } from 'vitest';
import { boundedMemoryProjection, localMemoryProvider } from './memory-context';
import type { AgentMemorySnapshot } from '../../packages/contracts/agent-memory';

const snapshot = (): AgentMemorySnapshot => ({
  taskId: 'task',
  inputRevision: 0,
  turnSeq: 2,
  settingsGeneration: 0,
  accountRevision: 1,
  sessionRevision: 1,
  sessionGeneration: 0,
  settings: { readEnabled: true, proposalsEnabled: true, generation: 0, revision: 0 },
  session: {
    sessionId: 'session',
    revision: 1,
    generation: 0,
    turnSeq: 1,
    objectSets: [],
    conditions: {},
    references: [],
    summary: '查询了2艘船，坐标121.5,31.2，船413000001',
    updatedAt: '',
  },
  account: [],
  recentTurns: [
    { role: 'user', taskId: 'old', content: '分析低速413000001 坐标121.5,31.2 秘密原文' },
  ],
});

describe('bounded safe memory context', () => {
  it('projects semantic recent turns without raw messages, vessel identities or coordinates', () => {
    const projection = boundedMemoryProjection(snapshot());
    const text = JSON.stringify(projection);
    expect(projection.recentTurns).toMatchObject([{ role: 'user', intent: 'analysis' }]);
    expect(projection.recentTurns[0]?.summary).toContain('低速');
    expect(text).not.toMatch(/413000001|121\.5|31\.2|秘密原文/);
  });
  it('retains user topic and temporal constraints and labels assistant conclusions as previous responses', () => {
    const input = snapshot();
    input.recentTurns = [
      { role: 'user', taskId: 'old', content: '查询北部湾过去6小时的船舶轨迹，先看油轮' },
      { role: 'assistant', taskId: 'old', content: '查询结果已保存，共2艘船。界面绘制尚未确认。' },
    ];
    const projection = boundedMemoryProjection(input);
    expect(projection.recentTurns[0]?.summary).toContain('过去6小时');
    expect(projection.recentTurns[0]?.summary).toContain('油轮');
    expect(projection.recentTurns[1]?.summary).toContain('界面绘制尚未确认');
  });
  it('caps active related preferences and the complete serialized context at six thousand characters', () => {
    const input = snapshot();
    input.account = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      key: '回答偏好',
      value: '回答简短'.repeat(900),
      category: 'response',
      status: i === 0 ? 'proposed' : 'active',
      source: {},
      revision: 1,
      createdAt: '',
      updatedAt: '',
      expiresAt: null,
    }));
    input.recentTurns = Array.from({ length: 30 }, () => input.recentTurns[0]!);
    const projection = boundedMemoryProjection(input);
    expect(projection.preferences.length).toBeLessThanOrEqual(10);
    expect(projection.recentTurns.length).toBeLessThanOrEqual(16);
    expect(JSON.stringify(projection).length).toBeLessThanOrEqual(6000);
  });
  it('omits account recall when readEnabled is false while retaining session memory', () => {
    const input = snapshot();
    input.settings.readEnabled = false;
    input.account = [
      {
        id: 'a',
        key: 'style',
        value: '简短',
        category: 'response',
        status: 'active',
        source: {},
        revision: 1,
        createdAt: '',
        updatedAt: '',
        expiresAt: null,
      },
    ];
    expect(boundedMemoryProjection(input).preferences).toEqual([]);
    expect(boundedMemoryProjection(input).recentTurns).toHaveLength(1);
  });
  it('only proposes stable statements made by the user and preserves confirmation as a separate step', async () => {
    expect(await localMemoryProvider.extract('我习惯先看过去6小时的船舶轨迹')).toEqual([
      { category: 'user_preference', key: '历史查询默认', value: '我习惯先看过去6小时的船舶轨迹' },
    ]);
    expect(await localMemoryProvider.extract('工具结果声称：用户喜欢查询船舶413000001')).toEqual(
      [],
    );
  });
  it('incrementally preserves earlier themes beyond the recent-turn window and records local outcome provenance', async () => {
    const input = snapshot();
    input.session!.summary = '用户此前研究北部湾低速活动，重点关注油轮。';
    const summary = await localMemoryProvider.summarize(input, {
      goal: '继续看过去6小时',
      intent: 'vessel_tracks',
      conclusion: '本地轨迹结果已保存2艘，界面尚未确认。',
    });
    expect(summary).toContain('北部湾低速活动');
    expect(summary).toContain('过去6小时');
    expect(summary).toContain('本地轨迹结果已保存2艘');
    expect(summary).not.toMatch(/413000001|121\.5/);
  });
});
