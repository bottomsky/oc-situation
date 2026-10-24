import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as preparation from './prepare-maritime-map';
import {
  normalizeMaritimeGeoJson,
  overpassToGeoJson,
  prepareMaritimeMap,
  publishMaritimeMap,
} from './prepare-maritime-map';

const roots: string[] = [];
async function temporaryRoot() {
  const base = resolve('.data/chart-coverage-fix/tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'ais-map-'));
  roots.push(root);
  return root;
}
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
const landWithRings = (rings: number[][][]) =>
  normalizeMaritimeGeoJson(
    {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'land',
          properties: { source: 'OSM' },
          geometry: { type: 'Polygon', coordinates: rings },
        },
      ],
    },
    'land',
  );
const deriveCoastline = (land: ReturnType<typeof normalizeMaritimeGeoJson>) => {
  expect(preparation).toHaveProperty('deriveMaritimeCoastline');
  return preparation.deriveMaritimeCoastline(land);
};
describe('coastline derivation', () => {
  it.each([
    [
      [105, 10],
      [105, 20],
      [110, 15],
      [105, 10],
    ],
    [
      [135, 10],
      [135, 20],
      [130, 15],
      [135, 10],
    ],
    [
      [110, 3],
      [120, 3],
      [115, 10],
      [110, 3],
    ],
    [
      [110, 42],
      [120, 42],
      [115, 35],
      [110, 42],
    ],
  ])('removes an artificial clip edge while keeping its real coastal approach: %j', (...ring) => {
    const land = landWithRings([ring]);
    const before = JSON.stringify(land);
    const result = deriveCoastline(land);
    expect(result.features[0]?.geometry).toEqual({
      type: 'MultiLineString',
      coordinates: [[ring[1], ring[2], ring[3]]],
    });
    expect(JSON.stringify(land)).toBe(before);
    expect(result.features[0]?.id).toBe('land');
  });
  it('merges real coastal segments across the closed-ring start without bridging clipped edges', () => {
    const ring = [
      [115, 35],
      [110, 42],
      [120, 42],
      [125, 35],
      [115, 35],
    ];
    expect(deriveCoastline(landWithRings([ring])).features[0]?.geometry).toEqual({
      type: 'MultiLineString',
      coordinates: [
        [
          [120, 42],
          [125, 35],
          [115, 35],
          [110, 42],
        ],
      ],
    });
  });
  it('retains closed real shoreline, holes and every polygon without joining separate rings', () => {
    const outside = [
      [110, 10],
      [120, 10],
      [120, 30],
      [110, 10],
    ];
    const hole = [
      [115, 15],
      [116, 15],
      [116, 16],
      [115, 15],
    ];
    const island = [
      [125, 20],
      [126, 20],
      [126, 21],
      [125, 20],
    ];
    const land = normalizeMaritimeGeoJson(
      {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: { type: 'MultiPolygon', coordinates: [[outside, hole], [island]] },
          },
        ],
      },
      'land',
    );
    expect(deriveCoastline(land).features[0]?.geometry).toEqual({
      type: 'MultiLineString',
      coordinates: [outside, hole, island],
    });
  });
  it('filters all four bounding edges with coordinate tolerance and returns no false shoreline', () => {
    const ring = [
      [105 + 1e-9, 3],
      [135, 3],
      [135, 42 - 1e-9],
      [105, 42],
      [105 + 1e-9, 3],
    ];
    expect(deriveCoastline(landWithRings([ring])).features).toEqual([]);
    const inside = [
      [105 + 1e-5, 10],
      [105 + 1e-5, 20],
      [110, 15],
      [105 + 1e-5, 10],
    ];
    expect(deriveCoastline(landWithRings([inside])).features[0]?.geometry).toEqual({
      type: 'MultiLineString',
      coordinates: [inside],
    });
  });
  it('publishes coastline metadata and hashes with the original land provenance', async () => {
    const root = await temporaryRoot();
    const result = await publishMaritimeMap({
      outputRoot: root,
      version: 'derived',
      updatedAt: '2026-10-24T02:00:00Z',
      layers: {
        land: {
          data: normalizeMaritimeGeoJson(polygon, 'land'),
          source: 'https://osmdata.openstreetmap.de/',
          rawSha256: 'a'.repeat(64),
          sourceDataTime: '2026-10-22T01:00:00Z',
          retrievedAt: '2026-10-23T01:00:00Z',
        },
      },
    });
    expect(result).toHaveProperty('coastline');
    const body = await readFile(join(root, 'derived/coastline.geojson'));
    expect(result.coastline).toMatchObject({
      status: 'available',
      url: '/maps/maritime/derived/coastline.geojson',
      source: result.land.source,
      attribution: result.land.attribution,
      license: result.land.license,
      rawSha256: result.land.rawSha256,
      sourceDataTime: result.land.sourceDataTime,
      retrievedAt: result.land.retrievedAt,
      zoom: { min: 0, max: 9 },
      displayOnly: true,
      sha256: createHash('sha256').update(body).digest('hex'),
      derivedFrom: { url: result.land.url, sha256: result.land.sha256 },
    });
    expect(result.coastline.coverageNote).toContain('clip');
    expect(
      JSON.parse(await readFile(join(root, 'derived/metadata.json'), 'utf8')).coastline,
    ).toEqual(result.coastline);
  });
  it('publishes an unavailable coastline when land only contains clipping boundaries', async () => {
    const root = await temporaryRoot();
    const result = await publishMaritimeMap({
      outputRoot: root,
      version: 'empty',
      layers: {
        land: {
          data: landWithRings([
            [
              [105, 3],
              [135, 3],
              [135, 42],
              [105, 42],
              [105, 3],
            ],
          ]),
          source: 'local:test',
          rawSha256: 'b'.repeat(64),
        },
      },
    });
    expect(result).toHaveProperty('coastline');
    expect(result.coastline).toMatchObject({ status: 'unavailable', url: null, records: 0 });
  });
  it('reuses published resources offline with provenance, raw ports and failure state intact', async () => {
    const root = await temporaryRoot();
    const raw = '{"elements":[],"original":"ports source bytes"}\n';
    const land = {
      data: normalizeMaritimeGeoJson(polygon, 'land'),
      source: 'https://osmdata.openstreetmap.de/',
      rawSha256: 'a'.repeat(64),
      sourceDataTime: '2026-10-22T01:00:00Z',
      retrievedAt: '2026-10-23T01:00:00Z',
    };
    const ports = {
      ...land,
      data: normalizeMaritimeGeoJson(
        {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: { name: 'port' },
              geometry: { type: 'Point', coordinates: [120, 20] },
            },
          ],
        },
        'ports',
      ),
      raw,
      rawSha256: createHash('sha256').update(raw).digest('hex'),
    };
    const previous = await publishMaritimeMap({
      outputRoot: root,
      version: 'v2',
      layers: { land, ports },
      failures: { seamarks: 'The operation timed out.' },
    });
    const originalMetadata = await readFile(join(root, 'v2/metadata.json'), 'utf8');
    const originalLand = await readFile(join(root, 'v2/land.geojson'), 'utf8');
    const result = await prepareMaritimeMap([
      `--output=${root}`,
      '--version=v3',
      '--reuse-version=v2',
      `--cache=${join(root, 'cache')}`,
    ]);
    expect(result.land.status).toBe('available');
    expect(result.land).toMatchObject({
      source: previous.land.source,
      rawSha256: previous.land.rawSha256,
      retrievedAt: previous.land.retrievedAt,
      sourceDataTime: previous.land.sourceDataTime,
      sha256: previous.land.sha256,
    });
    expect(result.ports).toMatchObject({
      source: previous.ports.source,
      rawSha256: previous.ports.rawSha256,
      retrievedAt: previous.ports.retrievedAt,
      sourceDataTime: previous.ports.sourceDataTime,
      sha256: previous.ports.sha256,
    });
    expect(result.seamarks).toEqual(previous.seamarks);
    expect(await readFile(join(root, 'v3/ports.source.json'), 'utf8')).toBe(raw);
    expect(await readFile(join(root, 'v3/land.geojson'), 'utf8')).toBe(originalLand);
    expect(await readFile(join(root, 'v2/metadata.json'), 'utf8')).toBe(originalMetadata);
    await expect(
      prepareMaritimeMap([
        `--output=${root}`,
        '--version=v2',
        '--reuse-version=v2',
        `--cache=${join(root, 'cache')}`,
      ]),
    ).rejects.toThrow('already exists');
    expect(await readFile(join(root, 'v2/metadata.json'), 'utf8')).toBe(originalMetadata);
  });
  it('rejects a reused resource whose bytes no longer match its published hash', async () => {
    const root = await temporaryRoot();
    await publishMaritimeMap({
      outputRoot: root,
      version: 'v2',
      layers: {
        land: {
          data: normalizeMaritimeGeoJson(polygon, 'land'),
          source: 'local:test',
          rawSha256: 'a'.repeat(64),
        },
      },
    });
    await writeFile(join(root, 'v2/land.geojson'), JSON.stringify(polygon) + ' ');
    await expect(
      prepareMaritimeMap([
        `--output=${root}`,
        '--version=v3',
        '--reuse-version=v2',
        `--cache=${join(root, 'cache')}`,
      ]),
    ).rejects.toThrow('checksum');
  });
  it('rejects a reused source file truncated to zero bytes', async () => {
    const root = await temporaryRoot();
    const raw = '{"elements":[{"type":"node","id":1,"lon":120,"lat":20}]}';
    await publishMaritimeMap({
      outputRoot: root,
      version: 'v2',
      layers: {
        ports: {
          data: overpassToGeoJson(JSON.parse(raw), 'ports'),
          source: 'local:ports',
          raw,
          rawSha256: createHash('sha256').update(raw).digest('hex'),
        },
      },
    });
    await writeFile(join(root, 'v2/ports.source.json'), '');
    await expect(
      prepareMaritimeMap([
        `--output=${root}`,
        '--version=v3',
        '--reuse-version=v2',
        `--cache=${join(root, 'cache')}`,
      ]),
    ).rejects.toThrow('ports source checksum mismatch');
  });
  it('publishes and reuses an existing empty source whose hash matches its zero bytes', async () => {
    const root = await temporaryRoot();
    const emptyHash = createHash('sha256').update('').digest('hex');
    await publishMaritimeMap({
      outputRoot: root,
      version: 'v2',
      layers: {
        ports: {
          data: overpassToGeoJson(
            { elements: [{ type: 'node', id: 1, lon: 120, lat: 20 }] },
            'ports',
          ),
          source: 'local:ports',
          raw: '',
          rawSha256: emptyHash,
        },
      },
    });
    expect(await readFile(join(root, 'v2/ports.source.json'), 'utf8')).toBe('');
    const result = await prepareMaritimeMap([
      `--output=${root}`,
      '--version=v3',
      '--reuse-version=v2',
      `--cache=${join(root, 'cache')}`,
    ]);
    expect(result.ports.rawSha256).toBe(emptyHash);
    expect(await readFile(join(root, 'v3/ports.source.json'), 'utf8')).toBe('');
  });
});
describe('maritime map dataset preparation', () => {
  it('rejects unsafe versions and invalid source geometry before publication', async () => {
    const root = await temporaryRoot();
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
    const root = await temporaryRoot();
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
