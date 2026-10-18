import { prepareRouteDataset } from '../packages/infrastructure/route-navigation';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat, open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import pg from 'pg';

export const ROUTE_SOURCE = {
  commit: '4fcdc74cf4a072b3c493fcdd64b7bec47c1ad597',
  networkSha256: '75ca6cc130b3748f568196a9caf62889e9f096ec358f65223b4095ac070be0e7',
  networkUrl:
    'https://raw.githubusercontent.com/eurostat/searoute/4fcdc74cf4a072b3c493fcdd64b7bec47c1ad597/modules/core/src/main/resources/marnet/marnet_plus_5km.gpkg',
  landUrl: 'https://osmdata.openstreetmap.de/download/land-polygons-split-4326.zip',
  converter: 'ghcr.io/osgeo/gdal:ubuntu-small-3.11.4',
};
async function command(args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<string>((ok, bad) => {
    const child = spawn('docker', args, {
      env: { ...process.env, ...env },
      windowsHide: true,
      shell: false,
    });
    let output = '';
    let errors = '';
    child.stdout.on('data', (v) => (output += v));
    child.stderr.on('data', (v) => (errors += v));
    child.once('error', bad);
    child.once('exit', (code) =>
      code === 0
        ? ok(output)
        : bad(
            new Error(
              `GDAL exited ${code}: ${errors.replace(/password=\S+/gi, 'password=[redacted]')}`,
            ),
          ),
    );
  });
}
async function sha256(path: string) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}
async function download(url: string, path: string) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Source download failed: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(path));
  await writeFile(
    `${path}.source.json`,
    JSON.stringify(
      {
        url,
        downloadedAt: new Date().toISOString(),
        httpLastModified: response.headers.get('last-modified'),
        sourceDataTime: null,
      },
      null,
      2,
    ),
  );
}
/** Read a small ZIP entry without materializing the global shoreline archive. */
async function zipText(path: string, name: string) {
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    const tail = Buffer.alloc(Math.min(size, 65557));
    await file.read(tail, 0, tail.length, size - tail.length);
    let eocd = tail.length - 22;
    while (eocd >= 0 && tail.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    if (eocd < 0) throw new Error('Invalid ZIP directory');
    const length = tail.readUInt32LE(eocd + 12),
      offset = tail.readUInt32LE(eocd + 16);
    if (length > 10_000_000) throw new Error('ZIP directory too large');
    const central = Buffer.alloc(length);
    await file.read(central, 0, length, offset);
    for (let i = 0; i < central.length;) {
      if (central.readUInt32LE(i) !== 0x02014b50) throw new Error('Invalid ZIP entry');
      const nameLength = central.readUInt16LE(i + 28),
        extra = central.readUInt16LE(i + 30),
        comment = central.readUInt16LE(i + 32);
      if (central.toString('utf8', i + 46, i + 46 + nameLength) === name) {
        const compressed = central.readUInt32LE(i + 20),
          localOffset = central.readUInt32LE(i + 42),
          method = central.readUInt16LE(i + 10);
        if (compressed > 1_000_000) throw new Error('ZIP metadata too large');
        const header = Buffer.alloc(30);
        await file.read(header, 0, 30, localOffset);
        const data = Buffer.alloc(compressed);
        await file.read(
          data,
          0,
          compressed,
          localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28),
        );
        return (
          method === 0 ? data : method === 8 ? inflateRawSync(data) : Buffer.alloc(0)
        ).toString('utf8');
      }
      i += 46 + nameLength + extra + comment;
    }
    throw new Error('ZIP source metadata missing');
  } finally {
    await file.close();
  }
}
export async function importRouteData(options: {
  databaseUrl: string;
  directory?: string;
  download?: boolean;
  networkLayer?: string;
  geometryColumn?: string;
}) {
  const directory = resolve(options.directory ?? '.data/routes/raw');
  await mkdir(directory, { recursive: true });
  const network = join(directory, 'marnet_plus_5km.gpkg'),
    land = join(directory, 'land-polygons-split-4326.zip');
  if (options.download) {
    for (const [url, path] of [
      [ROUTE_SOURCE.networkUrl, network],
      [ROUTE_SOURCE.landUrl, land],
    ]) {
      try {
        await stat(path!);
      } catch {
        await download(url!, path!);
      }
    }
  }
  const landReadme = await zipText(land, 'land-polygons-split-4326/README.txt');
  const landSourceTime =
    landReadme.match(/Date of the data used is\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/)?.[1] ??
    null;
  const networkHash = await sha256(network),
    landHash = await sha256(land);
  if (networkHash !== ROUTE_SOURCE.networkSha256)
    throw new Error('Pinned SeaRoute SHA256 mismatch');
  const db = new URL(options.databaseUrl);
  const host = ['127.0.0.1', 'localhost'].includes(db.hostname)
    ? 'host.docker.internal'
    : db.hostname;
  const pgConnection = `PG:host=${host} port=${db.port || 5432} dbname=${db.pathname.slice(1)} user=${decodeURIComponent(db.username)}`;
  const base = [
    'run',
    '--rm',
    '-e',
    'PGPASSWORD',
    '-v',
    `${directory}:/data:ro`,
    ROUTE_SOURCE.converter,
  ];
  const env = { PGPASSWORD: decodeURIComponent(db.password) };
  const info = await command(
    [...base, 'ogrinfo', '-ro', '-so', '-al', '/data/marnet_plus_5km.gpkg'],
    env,
  );
  const layer = options.networkLayer ?? info.match(/Layer name: ([^\r\n]+)/)?.[1];
  if (!layer) throw new Error('Cannot identify SeaRoute layer');
  const version = `searoute-3.5-${networkHash.slice(0, 12)}-osm-${landHash.slice(0, 12)}`;
  const schema = `route_import_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({ connectionString: options.databaseUrl });
  const client = await pool.connect();
  try {
    const exists = await client.query('SELECT version FROM route_datasets WHERE version=$1', [
      version,
    ]);
    if (exists.rowCount)
      throw new Error(
        'Dataset already imported; choose explicitly whether to activate existing version',
      );
    await client.query(`CREATE SCHEMA ${schema}`);
    await command(
      [
        ...base,
        'ogr2ogr',
        '-f',
        'PostgreSQL',
        pgConnection,
        '/data/marnet_plus_5km.gpkg',
        layer,
        '-nln',
        `${schema}.network`,
        '-lco',
        'GEOMETRY_NAME=geom',
        '-lco',
        'UNLOGGED=ON',
        '-t_srs',
        'EPSG:4326',
        '-nlt',
        'PROMOTE_TO_MULTI',
        '-overwrite',
      ],
      env,
    );
    await command(
      [
        ...base,
        'ogr2ogr',
        '-f',
        'PostgreSQL',
        pgConnection,
        '/vsizip//data/land-polygons-split-4326.zip/land-polygons-split-4326/land_polygons.shp',
        '-nln',
        `${schema}.land`,
        '-lco',
        'GEOMETRY_NAME=geom',
        '-lco',
        'UNLOGGED=ON',
        '-t_srs',
        'EPSG:4326',
        '-nlt',
        'PROMOTE_TO_MULTI',
        '-overwrite',
      ],
      env,
    );
    const sourceMetadata = async (path: string) => {
      try {
        return JSON.parse(await readFile(`${path}.source.json`, 'utf8'));
      } catch {
        return { downloadedAt: null, httpLastModified: null, sourceDataTime: null };
      }
    };
    const manifest = {
      version,
      crs: 'EPSG:4326',
      converter: ROUTE_SOURCE.converter,
      importedAt: new Date().toISOString(),
      network: {
        url: ROUTE_SOURCE.networkUrl,
        commit: ROUTE_SOURCE.commit,
        sha256: networkHash,
        license: 'EUPL-1.2',
        ...(await sourceMetadata(network)),
      },
      land: {
        url: ROUTE_SOURCE.landUrl,
        sha256: landHash,
        license: 'ODbL-1.0',
        attribution: '© OpenStreetMap contributors',
        ...(await sourceMetadata(land)),
        sourceDataTime: landSourceTime,
        sourceReadme: landReadme,
      },
      layer,
      ogrinfo: info,
    };
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('route-data-import'))");
    await client.query('INSERT INTO route_datasets(version,manifest) VALUES($1,$2)', [
      version,
      JSON.stringify(manifest),
    ]);
    // Subdivision retains the complete shoreline while keeping spatial indexes selective.
    await client.query(
      `INSERT INTO route_land(dataset_version,geom,geog) SELECT $1,p.geom,p.geom::geography FROM ${schema}.land l CROSS JOIN LATERAL ST_Subdivide(ST_CollectionExtract(ST_MakeValid(l.geom),3),256) p(geom) WHERE NOT ST_IsEmpty(p.geom)`,
      [version],
    );
    const columns = (
      await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='network'",
        [schema],
      )
    ).rows.map((r) => r.column_name as string);
    // SeaRoute edge direction and endpoint IDs are reconstructed from complete line geometries.
    // Source channel labels are retained whenever present; geographic gates additionally close
    // Suez/Panama/Kiel/Corinth and high latitude routes until separately accepted.
    const channelColumn = ['channel', 'passage', 'pass', 'route', 'name'].find((c) =>
      columns.includes(c),
    );
    const label = channelColumn ? `COALESCE(n."${channelColumn}"::text,'')` : "''";
    await client.query(
      `CREATE UNLOGGED TABLE ${schema}.edges AS SELECT ST_LineMerge((ST_Dump(n.geom)).geom) AS geom,${label} AS label FROM ${schema}.network n`,
    );
    await client.query(
      `DELETE FROM ${schema}.edges WHERE GeometryType(geom)<>'LINESTRING' OR ST_NPoints(geom)<2`,
    );
    await client.query(
      `INSERT INTO route_nodes(dataset_version,id,coordinate,geog) SELECT $1,md5(ST_AsEWKB(point)::text),jsonb_build_array(ST_X(point),ST_Y(point)),point::geography FROM (SELECT ST_StartPoint(geom) AS point FROM ${schema}.edges UNION SELECT ST_EndPoint(geom) FROM ${schema}.edges) p`,
      [version],
    );
    await client.query(
      `INSERT INTO route_edges(dataset_version,from_id,to_id,coordinates,geog,channel) SELECT $1,md5(ST_AsEWKB(ST_StartPoint(geom))::text),md5(ST_AsEWKB(ST_EndPoint(geom))::text),(ST_AsGeoJSON(geom)::jsonb)->'coordinates',geom::geography,CASE WHEN label ~* 'suez|panama|kiel|corinth|canal' OR ST_Intersects(geom::geography,ST_MakeEnvelope(32.1,29.5,32.7,31.5,4326)::geography) OR ST_Intersects(geom::geography,ST_MakeEnvelope(-80.2,8.7,-79.3,9.6,4326)::geography) OR ST_Intersects(geom::geography,ST_MakeEnvelope(9.0,53.8,10.3,54.6,4326)::geography) OR ST_Intersects(geom::geography,ST_MakeEnvelope(22.8,37.8,23.2,38.1,4326)::geography) THEN 'canal' WHEN ST_YMax(geom)>66.5 THEN 'arctic' ELSE 'open' END FROM ${schema}.edges`,
      [version],
    );
    const counts = (
      await client.query(
        'SELECT (SELECT count(*) FROM route_land WHERE dataset_version=$1) AS land,(SELECT count(*) FROM route_nodes WHERE dataset_version=$1) AS nodes,(SELECT count(*) FROM route_edges WHERE dataset_version=$1) AS edges',
        [version],
      )
    ).rows[0];
    if (!Number(counts.land) || !Number(counts.nodes) || !Number(counts.edges))
      throw new Error('Incomplete route dataset');
    // Publish only after resumable base navigability preparation has completed.
    // A failed preparation leaves an inactive version that prepare-route-data can resume.
    await client.query('COMMIT');
    await prepareRouteDataset({ pool }, version);
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('route-data-import'))");
    await client.query('UPDATE route_datasets SET active=false WHERE active');
    await client.query('UPDATE route_datasets SET active=true WHERE version=$1', [version]);
    await client.query('COMMIT');
    await writeFile(
      join(directory, 'installed-manifest.json'),
      JSON.stringify({ ...manifest, counts }, null, 2),
    );
    return { ...manifest, counts };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
    await pool.end();
  }
}
if (
  import.meta.url === new URL(process.argv[1]!, 'file:///').href ||
  process.argv[1]?.replaceAll('\\', '/').endsWith('/scripts/import-route-data.ts')
) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  console.log(
    JSON.stringify(
      await importRouteData({
        databaseUrl: process.env.DATABASE_URL,
        download: process.argv.includes('--download'),
      }),
      null,
      2,
    ),
  );
}
