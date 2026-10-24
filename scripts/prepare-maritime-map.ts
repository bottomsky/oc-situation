import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { PredictionArea, PredictionCoordinate } from '../packages/contracts/reachability';

export const MARITIME_COVERAGE: [number, number, number, number] = [105, 3, 135, 42];
export const OSM_LAND_SOURCE =
  'https://osmdata.openstreetmap.de/download/simplified-land-polygons-complete-3857.zip';
const LICENSE = 'ODbL-1.0';
const ATTRIBUTION = '© OpenStreetMap contributors · https://www.openstreetmap.org/copyright';
type Kind = 'land' | 'ports' | 'seamarks';
type Feature = {
  type: 'Feature';
  id?: string | number;
  geometry: PredictionArea | { type: 'Point'; coordinates: PredictionCoordinate };
  properties: Record<string, unknown>;
};
export type MaritimeGeoJson = { type: 'FeatureCollection'; features: Feature[] };
type LayerInput = {
  data: MaritimeGeoJson;
  source: string;
  rawSha256: string;
  sourceDataTime?: string | null;
  retrievedAt?: string;
  raw?: string;
};
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function coordinate(v: unknown): PredictionCoordinate {
  if (
    !Array.isArray(v) ||
    v.length < 2 ||
    typeof v[0] !== 'number' ||
    typeof v[1] !== 'number' ||
    !Number.isFinite(v[0]) ||
    !Number.isFinite(v[1]) ||
    Math.abs(v[0]) > 180 ||
    Math.abs(v[1]) > 90
  )
    throw new Error('Invalid geographic coordinate');
  return [v[0], v[1]];
}
function inCoverage([lon, lat]: PredictionCoordinate) {
  return lon >= 105 - 1e-7 && lon <= 135 + 1e-7 && lat >= 3 - 1e-7 && lat <= 42 + 1e-7;
}
function ring(raw: unknown): PredictionCoordinate[] {
  if (!Array.isArray(raw) || raw.length < 4) throw new Error('Polygon ring must be closed');
  const points = raw.map(coordinate),
    a = points[0]!,
    b = points.at(-1)!;
  if (a[0] !== b[0] || a[1] !== b[1]) throw new Error('Polygon ring must be closed');
  if (!points.every(inCoverage))
    throw new Error('Land input must be clipped to coverage before publication');
  return points;
}
export function normalizeMaritimeGeoJson(raw: unknown, kind: Kind): MaritimeGeoJson {
  if (
    !isRecord(raw) ||
    raw.type !== 'FeatureCollection' ||
    !Array.isArray(raw.features) ||
    raw.features.length > 100000
  )
    throw new Error('Expected bounded GeoJSON FeatureCollection');
  const features: Feature[] = [];
  for (const item of raw.features) {
    if (!isRecord(item) || item.type !== 'Feature' || !isRecord(item.geometry))
      throw new Error('Invalid GeoJSON feature');
    const geometry = item.geometry;
    let normalized: Feature['geometry'];
    if (geometry.type === 'Point' && kind !== 'land') {
      const p = coordinate(geometry.coordinates);
      if (!inCoverage(p)) continue;
      normalized = { type: 'Point', coordinates: p };
    } else if (
      geometry.type === 'Polygon' &&
      kind === 'land' &&
      Array.isArray(geometry.coordinates) &&
      geometry.coordinates.length
    ) {
      normalized = { type: 'Polygon', coordinates: geometry.coordinates.map(ring) };
    } else if (
      geometry.type === 'MultiPolygon' &&
      kind === 'land' &&
      Array.isArray(geometry.coordinates) &&
      geometry.coordinates.length
    ) {
      normalized = {
        type: 'MultiPolygon',
        coordinates: geometry.coordinates.map((p) => {
          if (!Array.isArray(p) || !p.length) throw new Error('Invalid polygon');
          return p.map(ring);
        }),
      };
    } else throw new Error(`Unsupported ${kind} geometry`);
    features.push({
      type: 'Feature',
      ...(typeof item.id === 'string' || typeof item.id === 'number' ? { id: item.id } : {}),
      geometry: normalized,
      properties: isRecord(item.properties) ? item.properties : {},
    });
  }
  return { type: 'FeatureCollection', features };
}
export function overpassToGeoJson(raw: unknown, kind: 'ports' | 'seamarks'): MaritimeGeoJson {
  if (!isRecord(raw) || !Array.isArray(raw.elements) || raw.remark)
    throw new Error('Incomplete Overpass result');
  const features: Feature[] = [];
  for (const item of raw.elements) {
    if (!isRecord(item)) continue;
    const center = isRecord(item.center) ? item.center : item,
      tags = isRecord(item.tags) ? item.tags : {};
    if (typeof center.lon !== 'number' || typeof center.lat !== 'number') continue;
    const id = `${item.type}/${item.id}`;
    features.push({
      type: 'Feature',
      id,
      geometry: { type: 'Point', coordinates: [center.lon, center.lat] },
      properties: {
        ...tags,
        osmId: id,
        name: tags['name:zh'] ?? tags.name ?? tags['name:en'] ?? tags['seamark:name'] ?? '',
        kind: kind === 'ports' ? 'port' : (tags['seamark:type'] ?? 'seamark'),
        source: 'OpenStreetMap',
        positionBasis: isRecord(item.center) ? 'osm_geometry_center' : 'osm_node',
      },
    });
  }
  return normalizeMaritimeGeoJson({ type: 'FeatureCollection', features }, kind);
}
/** Publish all resource files before replacing the small manifest pointer. Version folders are immutable. */
export async function publishMaritimeMap(input: {
  outputRoot: string;
  version: string;
  layers: Partial<Record<Kind, LayerInput>>;
  failures?: Partial<Record<Kind, string>>;
  updatedAt?: string;
}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(input.version) || input.version.includes('..'))
    throw new Error('Unsafe dataset version');
  const root = resolve(input.outputRoot),
    versionRoot = join(root, input.version),
    updatedAt = input.updatedAt ?? new Date().toISOString();
  await mkdir(root, { recursive: true });
  if (
    await stat(versionRoot).then(
      () => true,
      () => false,
    )
  )
    throw new Error('Dataset version already exists');
  const staging = join(root, `.staging-${randomUUID()}`);
  await mkdir(staging);
  const layer = async (kind: Kind) => {
    const source = input.layers[kind];
    if (!source || !source.data.features.length)
      return {
        status: 'unavailable' as const,
        url: null,
        source: source?.source ?? null,
        license: LICENSE,
        attribution: ATTRIBUTION,
        reason: input.failures?.[kind] ?? 'No source records supplied',
        records: 0,
      };
    const data = normalizeMaritimeGeoJson(source.data, kind),
      body = JSON.stringify(data);
    await writeFile(join(staging, `${kind}.geojson`), body + '\n', 'utf8');
    if (source.raw) await writeFile(join(staging, `${kind}.source.json`), source.raw, 'utf8');
    return {
      status: 'available' as const,
      url: `/maps/maritime/${input.version}/${kind}.geojson`,
      source: source.source,
      license: LICENSE,
      attribution: ATTRIBUTION,
      records: data.features.length,
      sha256: createHash('sha256')
        .update(body + '\n')
        .digest('hex'),
      rawSha256: source.rawSha256,
      sourceDataTime: source.sourceDataTime ?? null,
      retrievedAt: source.retrievedAt ?? updatedAt,
      displayOnly: true,
      zoom: kind === 'land' ? { min: 0, max: 9 } : { min: 5, max: 18 },
      coverageNote:
        kind === 'land'
          ? 'OSM simplified land, intended for zoom 0–9; small islands and local shoreline detail may be omitted'
          : 'OSM contributed records within query bbox; incomplete coverage, geometry-center points are labels rather than harbour entrances',
    };
  };
  const land = await layer('land'),
    ports = await layer('ports'),
    seamarks = await layer('seamarks');
  const manifest = {
    version: input.version,
    coverage: MARITIME_COVERAGE,
    updatedAt,
    land,
    ports,
    seamarks,
    official: {
      status: 'unconfigured' as const,
      reason: 'Licensed official ENC provider required',
    },
    bathymetry: {
      status: 'unavailable' as const,
      url: null,
      source: null,
      license: null,
      attribution: null,
      reason: 'GEBCO or licensed bathymetry has not been installed',
    },
  };
  await writeFile(join(staging, 'metadata.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await rename(staging, versionRoot);
  const pointer = join(root, `.manifest-${randomUUID()}.json`);
  await writeFile(pointer, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await rename(pointer, join(root, 'manifest.json'));
  return manifest;
}
async function fetchLimited(
  url: string,
  options: RequestInit = {},
  maxBytes = 32 * 1024 * 1024,
  timeoutMs = 60000,
) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Sources require HTTPS');
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok || !response.body) throw new Error(`Source request failed: ${response.status}`);
  if (Number(response.headers.get('content-length')) > maxBytes)
    throw new Error('Source exceeds byte limit');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error('Source exceeds byte limit');
    }
    chunks.push(value);
  }
  return { buffer: Buffer.concat(chunks), modified: response.headers.get('last-modified') };
}
const LAND_CONVERTER = String.raw`
import sys,json,zipfile,io,math
import shapefile
from shapely.geometry import shape,box,mapping
from shapely.ops import transform
from shapely import make_valid
archive,out=sys.argv[1:3]
clip=box(105,3,135,42)
def project(x,y,z=None):
    return (x/6378137*180/math.pi,(2*math.atan(math.exp(y/6378137))-math.pi/2)*180/math.pi)
features=[]
with zipfile.ZipFile(archive) as z:
    shp=next(n for n in z.namelist() if n.endswith('.shp'))
    reader=shapefile.Reader(shp=io.BytesIO(z.read(shp)))
    for item in reader.iterShapes():
        xmin,ymin,xmax,ymax=item.bbox
        west,south=project(xmin,ymin);east,north=project(xmax,ymax)
        if east<105 or west>135 or north<3 or south>42: continue
        geo=make_valid(transform(project,shape(item.__geo_interface__))).intersection(clip)
        if geo.is_empty: continue
        polys=[geo] if geo.geom_type=='Polygon' else list(geo.geoms) if hasattr(geo,'geoms') else []
        for poly in polys:
            if poly.geom_type=='Polygon' and not poly.is_empty:
                features.append({'type':'Feature','properties':{'source':'OpenStreetMap','resolution':'OSM simplified land zoom 0-9'},'geometry':mapping(poly)})
with open(out,'w',encoding='utf-8') as f:json.dump({'type':'FeatureCollection','features':features},f,separators=(',',':'))
print(json.dumps({'features':len(features)}))
`;
async function convertLand(python: string, archive: string, output: string) {
  await new Promise<void>((ok, bad) => {
    const child = spawn(python, ['-c', LAND_CONVERTER, archive, output], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let error = '';
    child.stderr.on('data', (v) => (error += v));
    child.once('error', bad);
    child.once('exit', (code) =>
      code === 0 ? ok() : bad(new Error(`Land conversion failed (${code}): ${error.slice(-2000)}`)),
    );
  });
}
export async function prepareMaritimeMap(args: string[]) {
  const opts = Object.fromEntries(
    args.map((arg) => {
      const at = arg.indexOf('=');
      if (!arg.startsWith('--') || at < 3) throw new Error('Use --option=value arguments');
      return [arg.slice(2, at), arg.slice(at + 1)];
    }),
  );
  const version = z.string().min(1).parse(opts.version),
    outputRoot = resolve(opts.output ?? 'apps/web/public/maps/maritime'),
    cache = resolve(opts.cache ?? '.data/maritime');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(version) || version.includes('..'))
    throw new Error('Unsafe dataset version');
  await mkdir(cache, { recursive: true });
  const layers: Partial<Record<Kind, LayerInput>> = {},
    failures: Partial<Record<Kind, string>> = {};
  for (const kind of ['land', 'ports', 'seamarks'] as const) {
    const path = opts[kind],
      url = opts[`${kind}-url`];
    if (path || url) {
      const result = path
        ? { buffer: await readFile(resolve(path)), modified: null }
        : await fetchLimited(url!);
      layers[kind] = {
        data: normalizeMaritimeGeoJson(JSON.parse(result.buffer.toString('utf8')), kind),
        source: url ?? `local:${path}`,
        rawSha256: createHash('sha256').update(result.buffer).digest('hex'),
        sourceDataTime: result.modified,
      };
    }
  }
  for (const kind of ['ports', 'seamarks'] as const) {
    const path = opts[`${kind}-overpass`];
    if (!path) continue;
    const raw = await readFile(resolve(path), 'utf8'),
      parsed = JSON.parse(raw);
    layers[kind] = {
      data: overpassToGeoJson(parsed, kind),
      source: opts[`${kind}-source`] ?? 'https://overpass-api.de/api/interpreter',
      rawSha256: createHash('sha256').update(raw).digest('hex'),
      sourceDataTime: isRecord(parsed.osm3s) ? String(parsed.osm3s.timestamp_osm_base) : null,
      raw,
    };
  }
  if (!layers.land && (opts['land-zip'] || opts.download === 'true')) {
    const archive = resolve(
        opts['land-zip'] ?? join(cache, 'simplified-land-polygons-complete-3857.zip'),
      ),
      source = opts['land-source'] ?? OSM_LAND_SOURCE;
    let modified = opts['land-modified'] ?? null;
    if (!opts['land-zip']) {
      const result = await fetchLimited(source, {}, 40 * 1024 * 1024, 180000);
      await writeFile(archive, result.buffer);
      modified = result.modified;
    }
    const converted = join(cache, `land-${version}.geojson`);
    await convertLand(opts.python ?? 'python', archive, converted);
    const bytes = await readFile(archive);
    layers.land = {
      data: normalizeMaritimeGeoJson(JSON.parse(await readFile(converted, 'utf8')), 'land'),
      source,
      rawSha256: createHash('sha256').update(bytes).digest('hex'),
      sourceDataTime: modified,
    };
    await writeFile(
      `${archive}.source.json`,
      JSON.stringify(
        {
          url: source,
          sha256: layers.land.rawSha256,
          httpLastModified: modified,
          retrievedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
    );
  }
  if (opts.overpass === 'true') {
    for (const kind of ['ports', 'seamarks'] as const) {
      if (layers[kind]) continue;
      const bbox = '(3,105,42,135)',
        query =
          kind === 'ports'
            ? `[out:json][timeout:45][maxsize:33554432];(nwr["harbour"~"^(yes|port)$"]${bbox};nwr["landuse"="port"]${bbox};nwr["industrial"="port"]${bbox};nwr["seamark:type"="harbour"]${bbox};);out center tags;`
            : `[out:json][timeout:45][maxsize:33554432];${opts['seamarks-nodes'] === 'true' ? 'node' : 'nwr'}["seamark:type"]${bbox};out center tags;`;
      const endpoints = opts['overpass-url']
        ? [opts['overpass-url']]
        : [
            'https://overpass-api.de/api/interpreter',
            'https://overpass.private.coffee/api/interpreter',
          ];
      for (const endpoint of endpoints) {
        try {
          const response = await fetchLimited(
            endpoint,
            {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ data: query }).toString(),
            },
            16 * 1024 * 1024,
            60000,
          );
          const raw = response.buffer.toString('utf8'),
            parsed = JSON.parse(raw);
          layers[kind] = {
            data: overpassToGeoJson(parsed, kind),
            source: endpoint,
            rawSha256: createHash('sha256').update(response.buffer).digest('hex'),
            sourceDataTime: isRecord(parsed.osm3s) ? String(parsed.osm3s.timestamp_osm_base) : null,
            raw,
          };
          await writeFile(join(cache, `${kind}-${version}.overpass.json`), raw);
          await writeFile(join(cache, `${kind}-${version}.query.txt`), query + '\n');
          break;
        } catch (error) {
          failures[kind] = error instanceof Error ? error.message : String(error);
        }
      }
    }
  }
  return publishMaritimeMap({ outputRoot, version, layers, failures });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareMaritimeMap(process.argv.slice(2))
    .then((manifest) => console.log(JSON.stringify(manifest, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
