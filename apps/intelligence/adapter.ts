import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import {
  IntelligenceInputSchema,
  type IntelligenceSource,
} from '../../packages/contracts/intelligence';
import {
  archiveIntelligenceRaw,
  saveIntelligenceEvent,
} from '../../packages/infrastructure/fusion-data';
import type { Infrastructure } from '@ais/infrastructure';
import { safeRequest } from '../crawler/src/policy';
import { RequestBudget } from '../crawler/src/budget';
import { collectProvider, nextRevision } from './providers';
import { suggestObjectRelations } from './suggestions';

export function decodeStructuredEvents(bytes: Buffer, sourceId: string) {
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length > 1000) throw new Error('Structured feed exceeds 1000 events');
  return items.map((value) => {
    const input = IntelligenceInputSchema.parse(value);
    if (input.sourceId !== sourceId) throw new Error('Event source differs from registered source');
    return input;
  });
}
export async function readLocalFeed(endpoint: string, root: string): Promise<Buffer> {
  const base = await realpath(root);
  const target = resolve(base, endpoint);
  const rel = relative(base, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel))
    throw new Error('File is outside the configured intelligence directory');
  const canonical = await realpath(target);
  const canonicalRelative = relative(base, canonical);
  if (canonicalRelative.startsWith('..') || isAbsolute(canonicalRelative))
    throw new Error('File is outside the configured intelligence directory');
  const details = await stat(canonical);
  if (!details.isFile() || details.size > 10_485_760)
    throw new Error('Invalid or oversized feed file');
  const bytes = await readFile(canonical);
  if (bytes.length > 10_485_760) throw new Error('Feed exceeds byte limit');
  return bytes;
}
export async function ingestSource(
  infra: Infrastructure,
  source: IntelligenceSource,
  signal?: AbortSignal,
) {
  if (source.kind === 'manual') throw new Error('Manual sources use the structured ingestion API');
  if (source.adapter) {
    const archives = new Map<string, string>();
    const result = await collectProvider(
      source,
      async (document) => {
        const stored = await archiveIntelligenceRaw(
          infra,
          source.sourceId,
          document.body,
          document.contentType,
        );
        await infra.pool.query(
          'UPDATE intelligence_archives SET source_urls=ARRAY(SELECT DISTINCT unnest(source_urls || ARRAY[$2]::text[])) WHERE id=$1',
          [stored.archiveId, document.url],
        );
        archives.set(document.url, stored.archiveId);
      },
      signal,
    );
    let imported = 0;
    for (const incoming of result.events) {
      const rows = await infra.pool.query<{
        event: import('../../packages/contracts/intelligence').IntelligenceEvent;
      }>(
        'SELECT event FROM intelligence_events WHERE source_id=$1 AND external_id=$2 ORDER BY version DESC LIMIT 1',
        [source.sourceId, incoming.externalId],
      );
      const revision = nextRevision(incoming, rows.rows[0]?.event);
      if (!revision) continue;
      revision.relations = [
        ...(revision.relations ?? []),
        ...(await suggestObjectRelations(infra, revision)),
      ];
      const originalArchiveId =
        archives.get(incoming.originalUrl ?? '') ?? archives.get(source.endpoint!);
      await saveIntelligenceEvent(infra, { ...revision, originalArchiveId });
      imported++;
    }
    return {
      imported,
      unchanged: result.events.length - imported,
      requiresStructuring: result.pending.length > 0,
      pending: result.pending,
      failures: result.failures,
    };
  }
  let bytes: Buffer;
  if (source.kind === 'fixture')
    bytes = await readFile(fileURLToPath(new URL('./fixtures/port-notice.json', import.meta.url)));
  else if (source.kind === 'file') {
    const root = process.env.INTELLIGENCE_FILE_ROOT;
    if (!root || !source.endpoint)
      throw new Error(
        'Local sources require explicit INTELLIGENCE_FILE_ROOT and relative endpoint',
      );
    bytes = await readLocalFeed(source.endpoint, root);
  } else {
    if (!source.authorizationConfirmed || !source.endpoint)
      throw new Error('Source authorization is required');
    const response = await safeRequest(
      source.endpoint,
      {
        allowedHosts: source.allowedHosts,
        timeoutSeconds: source.timeoutSeconds,
        budget: new RequestBudget(30, 1),
      },
      signal,
    );
    if (response.status !== 200) throw new Error(`Intelligence HTTP ${response.status}`);
    bytes = response.body;
  }
  // Preserve the response byte-for-byte before interpreting the structured representation.
  const archived = await archiveIntelligenceRaw(
    infra,
    source.sourceId,
    bytes,
    source.kind === 'rss' ? 'application/xml' : 'application/json',
  );
  if (source.kind === 'rss') {
    const document = load(bytes.toString('utf8'), { xmlMode: true });
    const count = document('item,entry').length;
    if (count > 1000) throw new Error('RSS feed exceeds 1000 entries');
    // RSS is raw evidence for operator structuring; no inferred applicability enters topic rules.
    return { imported: 0, requiresStructuring: true, entries: count, ...archived };
  }
  const events = decodeStructuredEvents(bytes, source.sourceId);
  for (const event of events)
    await saveIntelligenceEvent(infra, { ...event, originalArchiveId: archived.archiveId });
  return { imported: events.length, requiresStructuring: false, ...archived };
}
