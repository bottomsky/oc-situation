import { expect, it } from 'vitest';
import * as situation from './maritimeSituation';

it('自定义时长按分钟归一，小时与天允许精确换算，非法与越界输入保留为无效', () => {
  expect(typeof situation.situationAgeMinutes).toBe('function');
  if (typeof situation.situationAgeMinutes !== 'function') return;
  expect(situation.situationAgeMinutes(15, 'minutes')).toBe(15);
  expect(situation.situationAgeMinutes(1.5, 'hours')).toBe(90);
  expect(situation.situationAgeMinutes(1.15, 'hours')).toBe(69);
  expect(situation.situationAgeMinutes(0.5, 'days')).toBe(720);
  expect(situation.situationAgeMinutes(30, 'days')).toBe(43200);
  for (const [value, unit] of [
    [0, 'minutes'],
    [-1, 'hours'],
    [1.5, 'minutes'],
    [0.001, 'hours'],
    [31, 'days'],
    [NaN, 'minutes'],
    [Infinity, 'days'],
  ] as const)
    expect(situation.situationAgeMinutes(value, unit)).toBeNull();
});

it('共享hours值按分钟、小时和天友好呈现，恢复草稿保持同一整分钟时长', () => {
  expect(typeof situation.situationAgeLabel).toBe('function');
  expect(typeof situation.situationAgeDraft).toBe('function');
  if (
    typeof situation.situationAgeLabel !== 'function' ||
    typeof situation.situationAgeDraft !== 'function'
  )
    return;
  expect(situation.situationAgeLabel(0.25)).toBe('15分钟');
  expect(situation.situationAgeLabel(1.5)).toBe('1小时30分钟');
  expect(situation.situationAgeLabel(24)).toBe('1天');
  expect(situation.situationAgeLabel(30)).toBe('1天6小时');
  expect(situation.situationAgeLabel(720)).toBe('30天');
  for (const hours of [1 / 60, 0.25, 1.5, 12, 24, 25, 720]) {
    const draft = situation.situationAgeDraft(hours);
    expect(situation.situationAgeMinutes(draft.value, draft.unit)).toBe(Math.round(hours * 60));
  }
});
