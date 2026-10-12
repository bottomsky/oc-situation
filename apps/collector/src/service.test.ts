import { expect, it } from 'vitest';
import { SourceSettingsSchema, type SourceConfig } from '@ais/contracts';
import { assertLiveSource, streamSubscription, redactError } from './service';
const source: SourceConfig = {
  sourceId: 'stream',
  sourceKind: 'aisstream',
  name: 'stream',
  status: 'enabled',
  priority: 200,
  secretRef: 'KEY',
  settings: SourceSettingsSchema.parse({ authorizationConfirmed: true }),
};
it('requires persisted enable authorization and secret reference for live collection', () => {
  expect(() => assertLiveSource(source, { KEY: 'abc' })).not.toThrow();
  expect(() => assertLiveSource({ ...source, status: 'disabled' }, { KEY: 'abc' })).toThrow();
  expect(() =>
    assertLiveSource({ ...source, settings: SourceSettingsSchema.parse({}) }, { KEY: 'abc' }),
  ).toThrow();
});
it('uses one global subscription and redacts provider URL and secret error text', () => {
  expect(streamSubscription(source, 'abc')).toMatchObject({
    BoundingBoxes: [
      [
        [-90, -180],
        [90, 180],
      ],
    ],
  });
  expect(
    redactError(
      new Error('fetch https://services.marinetraffic.com/api/exportvessels/abc?v=9 abc'),
      ['abc'],
    ),
  ).not.toContain('abc');
});
