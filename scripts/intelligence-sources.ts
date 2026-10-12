import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInfrastructure } from '@ais/infrastructure';
import { publicIntelligenceSources } from '../apps/intelligence/source-presets';
import { collectProvider, decodeGdacs, decodeMaritimeHtml } from '../apps/intelligence/providers';
import { safeRequest } from '../apps/crawler/src/policy';
import { ingestSource } from '../apps/intelligence/adapter';
import { IntelligenceSourceSchema } from '../packages/contracts/intelligence';
import { loadReplayValidation } from '../apps/intelligence/replay';
import { nextRevision } from '../apps/intelligence/providers';
import {
  archiveIntelligenceRaw,
  saveIntelligenceEvent,
} from '../packages/infrastructure/fusion-data';
import { getLatestIntelligenceEvent } from '../packages/infrastructure/intelligence-store';
import { suggestObjectRelations } from '../apps/intelligence/suggestions';

const mode = process.argv[2] ?? 'validate';
if (mode === 'replay-validation') {
  const captures = await loadReplayValidation();
  const infra = await createInfrastructure();
  const results: unknown[] = [];
  try {
    for (const source of publicIntelligenceSources)
      await infra.pool.query(
        'INSERT INTO intelligence_sources(id,config) VALUES($1,$2::jsonb) ON CONFLICT(id) DO NOTHING',
        [source.sourceId, JSON.stringify(source)],
      );
    for (const capture of captures) {
      const registered = await infra.pool.query(
        'SELECT config FROM intelligence_sources WHERE id=$1',
        [capture.sourceId],
      );
      const source = IntelligenceSourceSchema.parse(registered.rows[0].config);
      if (!source.enabled) {
        results.push({ sourceId: capture.sourceId, url: capture.url, skipped: 'disabled' });
        continue;
      }
      const stored = await archiveIntelligenceRaw(
        infra,
        capture.sourceId,
        capture.body,
        capture.contentType,
      );
      await infra.pool.query(
        'UPDATE intelligence_archives SET source_urls=ARRAY(SELECT DISTINCT unnest(source_urls || ARRAY[$2]::text[])) WHERE id=$1',
        [stored.archiveId, capture.url],
      );
      for (const incoming of capture.events) {
        const latest = await getLatestIntelligenceEvent(
          infra,
          capture.sourceId,
          incoming.externalId,
        );
        const revision = nextRevision(incoming, latest);
        if (!revision) {
          results.push({
            sourceId: capture.sourceId,
            url: capture.url,
            unchanged: true,
            eventId: latest!.id,
            archiveId: stored.archiveId,
            sha256: capture.sha256,
          });
          continue;
        }
        revision.raw = {
          ...(revision.raw as Record<string, unknown>),
          replayEvidence: {
            capturedAt: capture.capturedAt,
            url: capture.url,
            sha256: capture.sha256,
            hashBasis: capture.hashBasis,
            mode: 'validated-capture-replay',
          },
        };
        revision.relations = [
          ...(revision.relations ?? []),
          ...(await suggestObjectRelations(infra, revision)),
        ];
        const saved = await saveIntelligenceEvent(infra, {
          ...revision,
          originalArchiveId: stored.archiveId,
        });
        results.push({
          sourceId: capture.sourceId,
          url: capture.url,
          eventId: saved.id,
          archiveId: stored.archiveId,
          sha256: capture.sha256,
          hashBasis: capture.hashBasis,
          imported: true,
        });
      }
      if (capture.pending)
        results.push({
          sourceId: capture.sourceId,
          url: capture.url,
          archiveId: stored.archiveId,
          pending: capture.pending,
        });
    }
    const result = {
      mode: 'validated-capture-replay',
      completedAt: new Date().toISOString(),
      results,
    };
    await writeFile(
      resolve('.data/replay-validation-result.json'),
      JSON.stringify(result, null, 2) + '\n',
    );
    console.log(JSON.stringify(result));
  } finally {
    await infra.close();
  }
} else if (mode === 'register' || mode === 'ingest') {
  const infra = await createInfrastructure();
  try {
    for (const source of publicIntelligenceSources)
      await infra.pool.query(
        `INSERT INTO intelligence_sources(id,config) VALUES($1,$2::jsonb) ON CONFLICT(id) ${process.argv.includes('--replace') ? 'DO UPDATE SET config=excluded.config' : 'DO NOTHING'}`,
        [source.sourceId, JSON.stringify(source)],
      );
    console.log(JSON.stringify({ registered: publicIntelligenceSources.map((s) => s.sourceId) }));
    if (mode === 'ingest') {
      for (const preset of publicIntelligenceSources) {
        const rows = await infra.pool.query('SELECT config FROM intelligence_sources WHERE id=$1', [
          preset.sourceId,
        ]);
        const source = IntelligenceSourceSchema.parse(rows.rows[0].config);
        if (!source.enabled) {
          console.log(JSON.stringify({ sourceId: source.sourceId, skipped: 'disabled' }));
          continue;
        }
        const lock = await infra.pool.connect();
        let acquired = false;
        try {
          const locked = await lock.query(
            'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',
            [`intelligence:${source.sourceId}`],
          );
          acquired = Boolean(locked.rows[0]?.acquired);
          if (!acquired) continue;
          const result = await ingestSource(infra, source, AbortSignal.timeout(120000));
          const failures = 'failures' in result ? (result.failures ?? []) : [];
          await infra.pool.query(
            'UPDATE intelligence_sources SET last_polled_at=now(),last_error=$2,last_ingestion=$3::jsonb,last_successful_at=CASE WHEN $4::boolean THEN now() ELSE last_successful_at END WHERE id=$1',
            [
              source.sourceId,
              failures.length
                ? JSON.stringify(failures).slice(0, 4000)
                : 'pending' in result && result.pending?.length
                  ? `${result.pending.length} documents archived pending manual structuring`
                  : null,
              JSON.stringify(result),
              failures.length === 0,
            ],
          );
          console.log(JSON.stringify({ sourceId: source.sourceId, ...result }));
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Source failed';
          await infra.pool.query(
            'UPDATE intelligence_sources SET last_polled_at=now(),last_error=$2,last_ingestion=$3::jsonb WHERE id=$1',
            [
              source.sourceId,
              message,
              JSON.stringify({ imported: 0, failed: true, error: message }),
            ],
          );
          console.log(JSON.stringify({ sourceId: source.sourceId, error: message }));
        } finally {
          if (acquired)
            await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
              `intelligence:${source.sourceId}`,
            ]);
          lock.release();
        }
      }
    }
  } finally {
    await infra.close();
  }
} else if (mode === '--verify-local' || mode === 'verify-local') {
  const root = resolve('.data/intelligence-live-validation');
  const records = JSON.parse(await readFile(resolve(root, 'validation.json'), 'utf8')) as {
    sourceId: string;
    captures?: { file: string; url: string }[];
  }[];
  const events = [];
  for (const source of records.filter(
    (s) => s.sourceId === 'zhejiang-maritime' || s.sourceId === 'shanghai-maritime',
  ))
    for (const capture of source.captures ?? []) {
      if (!/\.html$/.test(capture.url)) continue;
      const value = decodeMaritimeHtml(
        await readFile(resolve(root, capture.file)),
        source.sourceId,
        capture.url,
      );
      if (!('reason' in value)) events.push(value);
    }
  events.push(...decodeGdacs(await readFile(resolve(root, 'gdacs-yagi.raw')), 'gdacs-near-china'));
  await writeFile(
    resolve(root, 'local-verification.json'),
    JSON.stringify({ verifiedAt: new Date().toISOString(), events }, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({ events: events.length, file: resolve(root, 'local-verification.json') }),
  );
} else if (mode === 'validate') {
  const root = resolve('.data/intelligence-live-validation');
  await mkdir(root, { recursive: true });
  const evidence: unknown[] = [];
  for (const source of publicIntelligenceSources) {
    const captures: unknown[] = [];
    try {
      const result = await collectProvider(
        source,
        async (doc) => {
          const sha256 = createHash('sha256').update(doc.body).digest('hex');
          const file = `${source.sourceId}-${sha256}.raw`;
          await writeFile(resolve(root, file), doc.body);
          captures.push({
            url: doc.url,
            file,
            sha256,
            bytes: doc.body.length,
            contentType: doc.contentType,
          });
        },
        AbortSignal.timeout(120000),
      );
      evidence.push({
        sourceId: source.sourceId,
        capturedAt: new Date().toISOString(),
        captures,
        ...result,
      });
    } catch (error) {
      evidence.push({
        sourceId: source.sourceId,
        captures,
        error: error instanceof Error ? error.message : 'Provider failed',
      });
    }
    await writeFile(resolve(root, 'validation.json'), JSON.stringify(evidence, null, 2) + '\n');
  }
  const url = 'https://www.gdacs.org/gdacsapi/api/events/geteventdata?eventtype=TC&eventid=1001090';
  try {
    const result = await safeRequest(
      url,
      { allowedHosts: ['www.gdacs.org'], timeoutSeconds: 20 },
      AbortSignal.timeout(30000),
    );
    if (result.status !== 200) throw new Error(`HTTP ${result.status}`);
    await writeFile(resolve(root, 'gdacs-yagi.raw'), result.body);
    evidence.push({
      sourceId: 'gdacs-historical-validation',
      url,
      events: decodeGdacs(result.body, 'gdacs-near-china'),
    });
  } catch (error) {
    evidence.push({
      sourceId: 'gdacs-historical-validation',
      error: error instanceof Error ? error.message : 'Failed',
    });
  }
  await writeFile(resolve(root, 'validation.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(
    JSON.stringify(
      evidence.map((item) => {
        const v = item as {
          sourceId: string;
          events?: unknown[];
          pending?: unknown[];
          error?: string;
        };
        return {
          sourceId: v.sourceId,
          events: v.events?.length,
          pending: v.pending?.length,
          error: v.error,
        };
      }),
      null,
      2,
    ),
  );
} else throw new Error('Use register, ingest or validate');
