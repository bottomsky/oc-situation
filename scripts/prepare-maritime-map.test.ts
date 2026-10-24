import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeMaritimeGeoJson,
  overpassToGeoJson,
  publishMaritimeMap,
} from './prepare-maritime-map';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const polygon = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { source: 'OSM' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [120, 20],
            [121, 20],
            [121, 21],
            [120, 20],
          ],
        ],
      },
    },
  ],
};
describe('maritime map dataset preparation', () => {
  it('rejects unsafe versions and invalid source geometry before publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ais-map-'));
    roots.push(root);
    await expect(
      publishMaritimeMap({ outputRoot: root, version: '../escape', layers: {} }),
    ).rejects.toThrow('version');
    expect(() =>
      normalizeMaritimeGeoJson(
        {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: {
                type: 'Polygon',
                coordinates: [
                  [
                    [120, 20],
                    [121, 20],
                    [121, 21],
                  ],
                ],
              },
              properties: {},
            },
          ],
        },
        'land',
      ),
    ).toThrow('closed');
    expect(() =>
      normalizeMaritimeGeoJson(
        {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [Infinity, 20] },
              properties: {},
            },
          ],
        },
        'ports',
      ),
    ).toThrow('coordinate');
  });
  it('retains in-coverage real OSM-style points and filters remote records', () => {
    const features = overpassToGeoJson(
      {
        elements: [
          {
            type: 'node',
            id: 32947090,
            lat: 31.2304,
            lon: 121.4737,
            tags: { name: '上海', place: 'city' },
          },
          {
            type: 'way',
            id: 1,
            center: { lat: 29.9, lon: 122.1 },
            tags: { harbour: 'yes', name: '宁波港' },
          },
          { type: 'node', id: 2, lat: 0, lon: 0, tags: { harbour: 'yes' } },
        ],
      },
      'ports',
    );
    expect(features.features).toHaveLength(2);
    expect(features.features[0]!.properties.osmId).toBe('node/32947090');
  });
  it('atomically publishes versioned resources and truthful unavailable entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ais-map-'));
    roots.push(root);
    const result = await publishMaritimeMap({
      outputRoot: root,
      version: 'osm-test',
      layers: {
        land: {
          data: normalizeMaritimeGeoJson(polygon, 'land'),
          source: 'https://osmdata.openstreetmap.de/',
          rawSha256: 'a'.repeat(64),
        },
      },
    });
    expect(result.coverage).toEqual([105, 3, 135, 42]);
    expect(result.land.status).toBe('available');
    expect(result.land.url).toBe('/maps/maritime/osm-test/land.geojson');
    expect(result.seamarks.status).toBe('unavailable');
    expect(result.official.status).toBe('unconfigured');
    expect(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')).version).toBe(
      'osm-test',
    );
    expect(
      JSON.parse(await readFile(join(root, 'osm-test/land.geojson'), 'utf8')).features,
    ).toHaveLength(1);
    await expect(
      publishMaritimeMap({ outputRoot: root, version: 'osm-test', layers: {} }),
    ).rejects.toThrow();
  });
});
