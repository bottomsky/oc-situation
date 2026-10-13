import { describe, expect, it } from 'vitest';
import {
  AgentInputResponseSchema,
  AgentInputSpecSchema,
  AgentMapContextSchema,
  AgentMessageInputSchema,
  AgentQueryResultSchema,
  AgentTaskStatusSchema,
} from './agent';

describe('agent input boundary', () => {
  it('defaults to 24 hours and accepts missing area for clarification', () => {
    expect(AgentMessageInputSchema.parse({ content: '分析区域低速活动' })).toEqual({
      content: '分析区域低速活动',
      historyHours: 24,
    });
  });
  it('rejects unbounded history, empty requests and reversed latitude', () => {
    expect(AgentMessageInputSchema.safeParse({ content: '分析', historyHours: 169 }).success).toBe(
      false,
    );
    expect(AgentMessageInputSchema.safeParse({ content: ' ' }).success).toBe(false);
    expect(
      AgentMessageInputSchema.safeParse({ content: '分析', bbox: [120, 40, 121, 30] }).success,
    ).toBe(false);
  });
  it('allows dateline regions and explicit durable states', () => {
    expect(
      AgentMessageInputSchema.safeParse({ content: '分析', bbox: [179, 0, -179, 20] }).success,
    ).toBe(true);
    expect(AgentTaskStatusSchema.parse('waiting_result')).toBe('waiting_result');
  });
  it('captures map context without requiring a confirmed analysis area', () => {
    const context = {
      bbox: [179, 0, -179, 20],
      capturedAt: '2026-10-13T00:00:00Z',
      selectedMmsis: ['412000001'],
      sourceId: 'fixture-http',
      shipType: 70,
      hours: 720,
    };
    expect(
      AgentMessageInputSchema.parse({ content: '当前视野有哪些船舶', mapContext: context }),
    ).toEqual({ content: '当前视野有哪些船舶', historyHours: 24, mapContext: context });
    expect(AgentMapContextSchema.safeParse({ ...context, execute: 'arbitrary code' }).success).toBe(
      false,
    );
  });
  it('bounds selection answers and distinguishes declining from submitting values', () => {
    expect(
      AgentInputResponseSchema.safeParse({
        action: 'accept',
        inputRevision: 2,
        values: { bbox: [120, 20, 130, 30], mmsis: ['412000001'], historyHours: 24 },
      }).success,
    ).toBe(true);
    expect(
      AgentInputResponseSchema.safeParse({
        action: 'accept',
        inputRevision: 2,
        values: { mmsis: ['412000001', '412000001'] },
      }).success,
    ).toBe(false);
    expect(
      AgentInputResponseSchema.safeParse({
        action: 'decline',
        inputRevision: 2,
        values: { historyHours: 24 },
      }).success,
    ).toBe(false);
    expect(
      AgentInputResponseSchema.safeParse({ action: 'decline', inputRevision: 2 }).success,
    ).toBe(true);
  });
  it('requires an unambiguous historical range and rejects unknown fields', () => {
    const timeRange = { from: '2026-10-12T00:00:00Z', to: '2026-10-13T00:00:00Z' };
    expect(
      AgentInputResponseSchema.safeParse({
        action: 'accept',
        inputRevision: 0,
        values: { timeRange },
      }).success,
    ).toBe(true);
    expect(
      AgentInputResponseSchema.safeParse({
        action: 'accept',
        inputRevision: 0,
        values: { timeRange, historyHours: 24 },
      }).success,
    ).toBe(false);
    expect(
      AgentInputResponseSchema.safeParse({
        action: 'accept',
        inputRevision: 0,
        values: { timeRange, userId: 'override-owner' },
      }).success,
    ).toBe(false);
    expect(
      AgentInputResponseSchema.safeParse({
        action: 'accept',
        inputRevision: 0,
        values: { timeRange: { from: timeRange.to, to: timeRange.from } },
      }).success,
    ).toBe(false);
  });
  it('accepts only supported input fields and purposes', () => {
    expect(
      AgentInputSpecSchema.safeParse({ fields: ['region', 'time'], reason: 'data_limit' }).success,
    ).toBe(true);
    expect(
      AgentInputSpecSchema.safeParse({ fields: ['region', 'region'], reason: 'missing_region' })
        .success,
    ).toBe(false);
    expect(
      AgentInputResponseSchema.safeParse({
        action: 'accept',
        inputRevision: 0,
        values: { purpose: 'save_draft' },
      }).success,
    ).toBe(false);
  });
  it('allows a persisted empty query result with a real input revision', () => {
    expect(
      AgentQueryResultSchema.parse({
        kind: 'vessel_list',
        version: 1,
        inputRevision: 3,
        total: 0,
        truncated: false,
        items: [],
        asOf: '2026-10-13T00:00:00Z',
        selection: { bbox: [120, 20, 130, 30] },
      }).total,
    ).toBe(0);
  });
});
