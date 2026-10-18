import { describe, expect, it } from 'vitest';
import { focusBounds, bboxFocusGeometry } from './agent-focus';
describe('focus bounds', () => {
  it('keeps dateline points together', () =>
    expect(
      focusBounds([
        { type: 'Point', coordinates: [179, 0] },
        { type: 'Point', coordinates: [-179, 1] },
      ]),
    ).toEqual([179, 0, -179, 1]));
  it('preserves a long explicitly sampled line', () =>
    expect(
      focusBounds([
        {
          type: 'LineString',
          coordinates: [
            [-170, 0],
            [-80, 0],
            [0, 0],
            [80, 0],
            [170, 0],
          ],
        },
      ]),
    ).toEqual([-170, 0, 170, 0]));
});

it('retains a continuous line covering every longitude', () => {
  expect(
    focusBounds([
      {
        type: 'LineString',
        coordinates: [
          [-180, 5],
          [-90, 5],
          [0, 5],
          [90, 5],
          [180, 5],
        ],
      },
    ]),
  ).toEqual([-180, 5, 180, 5]);
});
it('preserves the directed 340 degree extent of an explicit bbox', () => {
  expect(focusBounds([bboxFocusGeometry([-170, 20, 170, 30])])).toEqual([-170, 20, 170, 30]);
});
it('keeps an explicitly crossing bbox narrow', () => {
  expect(focusBounds([bboxFocusGeometry([170, 20, -170, 30])])).toEqual([170, 20, -170, 30]);
});
it('retains a full world bbox', () => {
  expect(focusBounds([bboxFocusGeometry([-180, -80, 180, 80])])).toEqual([-180, -80, 180, 80]);
});
it('keeps a continuous dateline segment narrow', () => {
  expect(
    focusBounds([
      {
        type: 'LineString',
        coordinates: [
          [179, 1],
          [-179, 2],
        ],
      },
    ]),
  ).toEqual([179, 1, -179, 2]);
});

it('combines continuous coverage from separate geometries before choosing a gap', () => {
  expect(
    focusBounds([
      {
        type: 'LineString',
        coordinates: [
          [-180, 0],
          [-90, 0],
          [0, 0],
        ],
      },
      {
        type: 'LineString',
        coordinates: [
          [0, 1],
          [90, 1],
          [180, 1],
        ],
      },
    ]),
  ).toEqual([-180, 0, 180, 1]);
});
it('chooses an actual uncovered gap smaller than the former sampling interval', () => {
  expect(
    focusBounds([
      {
        type: 'LineString',
        coordinates: [
          [-179.75, 0],
          [-90, 0],
          [0, 0],
          [90, 0],
          [179.75, 0],
        ],
      },
    ]),
  ).toEqual([-179.75, 0, 179.75, 0]);
});
it('does not add continuous coverage between multipoints', () => {
  expect(
    focusBounds([
      {
        type: 'MultiPoint',
        coordinates: [
          [-170, 0],
          [0, 1],
          [170, 2],
        ],
      },
    ]),
  ).toEqual([0, 0, -170, 2]);
});
