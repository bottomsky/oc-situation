import { expect, it } from 'vitest';
import { intelligenceFeatureBounds, intelligenceFeatureGroup } from './app/utils/intelligenceMap';
it('将候选、影响、位置、对象关系分组且定位支持线面', () => {
  expect(intelligenceFeatureGroup({ reviewStatus: 'candidate', kind: 'impacts' })).toBe(
    'candidate',
  );
  expect(intelligenceFeatureGroup({ reviewStatus: 'confirmed', kind: 'impacts' })).toBe('impact');
  expect(intelligenceFeatureGroup({ reviewStatus: 'confirmed', kind: 'occurs-at' })).toBe(
    'location',
  );
  expect(
    intelligenceFeatureBounds([
      {
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [120, 30],
              [122, 30],
              [122, 32],
              [120, 30],
            ],
          ],
        },
      },
    ]),
  ).toEqual([
    [120, 30],
    [122, 32],
  ]);
});

it('跨日界线几何定位选择最短经度区间', () => {
  expect(
    intelligenceFeatureBounds([
      {
        geometry: {
          coordinates: [
            [179, 30],
            [-179, 32],
          ],
        },
      },
    ]),
  ).toEqual([
    [179, 30],
    [181, 32],
  ]);
});
