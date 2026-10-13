import {
  Body,
  SetMetadata,
  Controller,
  Get,
  Inject,
  Post,
  Put,
  Param,
  Query,
  Req,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Infrastructure } from '@ais/infrastructure';
import {
  IntelligenceInputSchema,
  IntelligenceSourceSchema,
} from '../../../../packages/contracts/intelligence';
import {
  GeoObjectInputSchema,
  GeoObjectQuerySchema,
  GeoObjectImportSchema,
  RelationInputSchema,
  ReviewSchema,
  PlotRequestSchema,
  PlotSetSchema,
  IntelligenceEventQuerySchema,
  type IntelligenceRelation,
} from '../../../../packages/contracts/intelligence-spatial';
import {
  intelligenceDetail,
  queryIntelligenceEvents,
  writeGeoObject,
  writeRelation,
  plotIntelligence,
  reviewIntelligenceEvent,
  importGeoObjects,
  IntelligenceValidationError,
} from '../../../../packages/infrastructure/intelligence-store';
import { saveIntelligenceEvent } from '../../../../packages/infrastructure/fusion-data';
import { assertAllowedUrl } from '../../../crawler/src/policy';
import {
  INFRA,
  DocumentRoute,
  MinimumRole,
  parse,
  PageQuery,
  DocumentQuery,
  audit,
} from '../common';
import type { AuthRequest } from '../auth/guard';
import {
  IntelligenceSearchQuerySchema,
  IntelligenceSearchResultSchema,
} from '../../../../packages/contracts/intelligence-search';
import {
  searchIntelligence,
  IntelligenceSearchError,
} from '../../../../packages/infrastructure/intelligence-search';

export const IntelligenceSourceStatusSchema = IntelligenceSourceSchema.safeExtend({
  lastPolledAt: z.iso.datetime().nullable(),
  lastSuccessfulAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  lastIngestion: z.record(z.string(), z.unknown()),
});

@Controller('intelligence')
export class IntelligenceController {
  constructor(@Inject(INFRA) private readonly infra: Infrastructure) {}

  @Get('search')
  @DocumentQuery(IntelligenceSearchQuerySchema)
  @DocumentRoute(
    'Search locally stored intelligence with versioned source evidence',
    IntelligenceSearchResultSchema,
  )
  async search(@Query() query: unknown) {
    const { limit, cursor, ...spec } = parse(IntelligenceSearchQuerySchema, query);
    try {
      return await searchIntelligence(this.infra, spec, { limit, cursor });
    } catch (error) {
      if (error instanceof IntelligenceSearchError) throw new BadRequestException(error.message);
      if ((error as { code?: string }).code === '57014')
        throw new ServiceUnavailableException('情报检索超时，请缩小条件后重试');
      throw error;
    }
  }

  @Get('sources')
  @DocumentRoute(
    'Intelligence source configurations and polling status',
    z.array(IntelligenceSourceStatusSchema),
  )
  async sources() {
    return (
      await this.infra.pool.query(
        'SELECT config,last_polled_at,last_successful_at,last_error,last_ingestion FROM intelligence_sources ORDER BY id',
      )
    ).rows.map((r) => ({
      ...r.config,
      lastPolledAt: r.last_polled_at?.toISOString() ?? null,
      lastSuccessfulAt: r.last_successful_at?.toISOString() ?? null,
      lastError: r.last_error,
      lastIngestion: r.last_ingestion ?? {},
    }));
  }

  @Post('sources')
  @MinimumRole('admin')
  @DocumentRoute(
    'Register authorized intelligence source',
    IntelligenceSourceSchema,
    IntelligenceSourceSchema,
    201,
  )
  async createSource(@Body() value: unknown, @Req() req: AuthRequest) {
    const source = parse(IntelligenceSourceSchema, value);
    await this.validateSource(source);
    await this.infra.pool.query(
      'INSERT INTO intelligence_sources(id,config) VALUES($1,$2::jsonb)',
      [source.sourceId, JSON.stringify(source)],
    );
    await audit(
      this.infra,
      req.user.id,
      'intelligence.source.create',
      'intelligence_source',
      source.sourceId,
    );
    return source;
  }

  @Put('sources/:id')
  @MinimumRole('admin')
  @DocumentRoute(
    'Replace intelligence source configuration',
    IntelligenceSourceSchema,
    IntelligenceSourceSchema,
  )
  async updateSource(@Param('id') id: string, @Body() value: unknown, @Req() req: AuthRequest) {
    const source = parse(IntelligenceSourceSchema, value);
    if (source.sourceId !== id) throw new BadRequestException('Source id mismatch');
    await this.validateSource(source);
    const result = await this.infra.pool.query(
      'UPDATE intelligence_sources SET config=$2::jsonb,last_polled_at=NULL,next_poll_at=NULL,consecutive_failures=0 WHERE id=$1',
      [id, JSON.stringify(source)],
    );
    if (!result.rowCount) throw new NotFoundException('Source not found');
    await audit(this.infra, req.user.id, 'intelligence.source.update', 'intelligence_source', id);
    return source;
  }

  private async spatial<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (e) {
      if (e instanceof IntelligenceValidationError) {
        if (e.message.includes('not found')) throw new NotFoundException(e.message);
        throw new BadRequestException(e.message);
      }
      throw e;
    }
  }

  private async validateSource(source: z.infer<typeof IntelligenceSourceSchema>) {
    if (!['manual', 'fixture', 'file'].includes(source.kind)) {
      try {
        await assertAllowedUrl(source.endpoint!, { allowedHosts: source.allowedHosts });
      } catch {
        throw new BadRequestException('Source URL violates registered public HTTPS policy');
      }
    }
    if (source.kind === 'fixture' && source.sourceId !== 'fixture-intelligence')
      throw new BadRequestException('Fixture sourceId must be fixture-intelligence');
    if (source.kind === 'file' && (!source.endpoint || !process.env.INTELLIGENCE_FILE_ROOT))
      throw new BadRequestException(
        'File source requires configured INTELLIGENCE_FILE_ROOT and a relative endpoint',
      );
  }

  @Get('archives')
  @DocumentQuery(PageQuery)
  @DocumentRoute(
    'Raw intelligence archives awaiting operator structuring',
    z.object({ items: z.array(z.unknown()), nextCursor: z.string().nullable() }),
  )
  async archives(@Query() query: unknown) {
    const { limit, cursor } = parse(PageQuery, query);
    const rows = await this.infra.pool.query(
      'SELECT id,source_id AS "sourceId",object_key AS "archiveKey",checksum,bytes,content_type AS "contentType",source_urls AS "originalUrls",created_at AS "createdAt" FROM intelligence_archives WHERE ($1::text IS NULL OR id>$1) ORDER BY id LIMIT $2',
      [cursor ?? null, limit + 1],
    );
    return {
      items: rows.rows.slice(0, limit),
      nextCursor: rows.rows.length > limit ? rows.rows[limit - 1]!.id : null,
    };
  }

  @Get('archives/:id')
  @DocumentRoute(
    'Read immutable raw intelligence as inert text',
    z.object({
      id: z.string(),
      content: z.string(),
      contentType: z.string(),
      checksum: z.string(),
    }),
  )
  async archive(@Param('id') id: string) {
    const result = await this.infra.pool.query('SELECT * FROM intelligence_archives WHERE id=$1', [
      id,
    ]);
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Archive not found');
    const object = await this.infra.s3.send(
      new GetObjectCommand({ Bucket: this.infra.config.s3Bucket, Key: row.object_key }),
    );
    if (!object.Body || (object.ContentLength ?? 0) > 10_485_760)
      throw new Error('Archive unavailable or exceeds limit');
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
      length += chunk.length;
      if (length > 10_485_760) {
        (object.Body as unknown as { destroy?: () => void }).destroy?.();
        throw new Error('Archive exceeds limit');
      }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (createHash('sha256').update(bytes).digest('hex') !== row.checksum)
      throw new Error('Archive checksum mismatch');
    return {
      id,
      content: bytes.toString('utf8'),
      contentType: row.content_type,
      originalUrls: row.source_urls ?? [],
      checksum: row.checksum,
    };
  }

  @Get('events')
  @DocumentQuery(IntelligenceEventQuerySchema)
  @DocumentRoute(
    'Versioned intelligence evidence',
    z.object({ items: z.array(z.unknown()), nextCursor: z.string().nullable() }),
  )
  async events(@Query() query: unknown) {
    return queryIntelligenceEvents(this.infra, parse(IntelligenceEventQuerySchema, query));
  }

  @Post('events')
  @MinimumRole('operator')
  @DocumentRoute(
    'Ingest structured intelligence with immutable raw archive',
    z.unknown(),
    IntelligenceInputSchema,
    201,
  )
  async createEvent(@Body() value: unknown, @Req() req: AuthRequest) {
    const input = parse(IntelligenceInputSchema, value);
    const event = await saveIntelligenceEvent(this.infra, input);
    await audit(
      this.infra,
      req.user.id,
      'intelligence.event.create',
      'intelligence_event',
      event.id,
    );
    return event;
  }
  @Get('events/:id')
  @DocumentRoute('Read immutable evidence, current relations and audit history', z.unknown())
  async eventDetail(@Param('id') id: string) {
    const result = await intelligenceDetail(this.infra, id);
    if (!result) throw new NotFoundException('Event not found');
    return result;
  }
  @Post('events/:id/review')
  @DocumentRoute(
    'Record evidence review without altering source text',
    z.unknown(),
    ReviewSchema,
    201,
  )
  @MinimumRole('operator')
  async reviewEvent(@Param('id') id: string, @Body() value: unknown, @Req() req: AuthRequest) {
    const { reviewStatus } = parse(ReviewSchema, value);
    if (!(await intelligenceDetail(this.infra, id))) throw new NotFoundException('Event not found');
    await this.spatial(() => reviewIntelligenceEvent(this.infra, id, reviewStatus, req.user.id));
    await audit(this.infra, req.user.id, 'intelligence.event.review', 'intelligence_event', id);
    return intelligenceDetail(this.infra, id);
  }
  @Post('events/:id/relations')
  @DocumentRoute('Append evidence relation', z.unknown(), RelationInputSchema, 201)
  @MinimumRole('operator')
  async addRelation(@Param('id') id: string, @Body() value: unknown, @Req() req: AuthRequest) {
    const result = await this.spatial(() =>
      writeRelation(this.infra, id, parse(RelationInputSchema, value), req.user.id),
    );
    await audit(
      this.infra,
      req.user.id,
      'intelligence.relation.create',
      'intelligence_relation',
      result.id,
    );
    return result;
  }
  private async existingRelation(id: string) {
    const result = (
      await this.infra.pool.query<{ data: IntelligenceRelation }>(
        'SELECT data FROM intelligence_relations WHERE id=$1 ORDER BY revision DESC LIMIT 1',
        [id],
      )
    ).rows[0]?.data;
    if (!result) throw new NotFoundException('Relation not found');
    return result;
  }
  @Put('relations/:id')
  @DocumentRoute('Append relation revision', z.unknown(), RelationInputSchema)
  @MinimumRole('operator')
  async editRelation(@Param('id') id: string, @Body() value: unknown, @Req() req: AuthRequest) {
    const old = await this.existingRelation(id);
    const result = await this.spatial(() =>
      writeRelation(this.infra, old.eventId, parse(RelationInputSchema, value), req.user.id, id),
    );
    await audit(
      this.infra,
      req.user.id,
      'intelligence.relation.revise',
      'intelligence_relation',
      id,
    );
    return result;
  }
  @Post('relations/:id/review')
  @DocumentRoute('Record relation confirmation or rejection', z.unknown(), ReviewSchema, 201)
  @MinimumRole('operator')
  async reviewRelation(@Param('id') id: string, @Body() value: unknown, @Req() req: AuthRequest) {
    const old = await this.existingRelation(id);
    const {
      id: _id,
      eventId,
      revision: _revision,
      recordedAt: _at,
      reviewedBy: _actor,
      createdBy: _creator,
      objectSnapshot: _snapshot,
      ...input
    } = old;
    const result = await this.spatial(() =>
      writeRelation(
        this.infra,
        eventId,
        { ...input, ...parse(ReviewSchema, value) },
        req.user.id,
        id,
      ),
    );
    await audit(
      this.infra,
      req.user.id,
      'intelligence.relation.review',
      'intelligence_relation',
      id,
    );
    return result;
  }
  @Get('objects')
  @DocumentQuery(GeoObjectQuerySchema)
  @DocumentRoute(
    'Search geographical objects and aliases',
    z.object({ items: z.array(z.unknown()) }),
  )
  async objects(@Query() query: unknown) {
    const q = parse(GeoObjectQuerySchema, query);
    return {
      items: (
        await this.infra.pool.query(
          "SELECT data FROM intelligence_objects WHERE ($1::text IS NULL OR name ILIKE '%'||$1||'%' OR (data->'aliases')::text ILIKE '%'||$1||'%') AND ($2::text IS NULL OR kind=$2) ORDER BY name,id LIMIT $3",
          [q.keyword ?? null, q.kind ?? null, q.limit],
        )
      ).rows.map((r) => r.data),
    };
  }
  @Post('objects')
  @DocumentRoute('Create geographical object', z.unknown(), GeoObjectInputSchema, 201)
  @MinimumRole('operator')
  async createObject(@Body() value: unknown, @Req() req: AuthRequest) {
    const o = await this.spatial(() =>
      writeGeoObject(this.infra, parse(GeoObjectInputSchema, value)),
    );
    await audit(this.infra, req.user.id, 'intelligence.object.create', 'intelligence_object', o.id);
    return o;
  }
  @Put('objects/:id')
  @DocumentRoute('Update geographical object', z.unknown(), GeoObjectInputSchema)
  @MinimumRole('operator')
  async editObject(@Param('id') id: string, @Body() value: unknown, @Req() req: AuthRequest) {
    const input = parse(GeoObjectInputSchema, value);
    if (input.id && input.id !== id) throw new BadRequestException('Object id mismatch');
    if (
      !(await this.infra.pool.query('SELECT id FROM intelligence_objects WHERE id=$1', [id]))
        .rowCount
    )
      throw new NotFoundException('Object not found');
    const o = await this.spatial(() => writeGeoObject(this.infra, { ...input, id }));
    await audit(this.infra, req.user.id, 'intelligence.object.update', 'intelligence_object', id);
    return o;
  }
  @Post('objects/import')
  @DocumentRoute('Atomically import GeoJSON objects', z.unknown(), GeoObjectImportSchema, 201)
  @MinimumRole('operator')
  async importObjects(@Body() value: unknown, @Req() req: AuthRequest) {
    const collection = parse(GeoObjectImportSchema, value);
    const { items } = await this.spatial(() =>
      importGeoObjects(
        this.infra,
        collection.features.map((f) => ({
          ...f.properties,
          ...(f.id ? { id: f.id } : {}),
          geometry: f.geometry,
        })),
      ),
    );
    await audit(
      this.infra,
      req.user.id,
      'intelligence.object.import',
      'intelligence_object',
      'batch',
    );
    return { items };
  }
  @Post('plot')
  @MinimumRole('viewer')
  @SetMetadata('allowViewerWrite', true)
  @DocumentRoute('Plot selected evidence versions', z.unknown(), PlotRequestSchema, 201)
  async plot(@Body() value: unknown) {
    const q = parse(PlotRequestSchema, value);
    return this.spatial(() => plotIntelligence(this.infra, q.eventIds, q.includeCandidates));
  }
  @Get('plot-set')
  @DocumentRoute('Read personal plot version references', PlotSetSchema)
  async plotSet(@Req() req: AuthRequest) {
    return (
      (
        await this.infra.pool.query('SELECT data FROM intelligence_plot_sets WHERE user_id=$1', [
          req.user.id,
        ])
      ).rows[0]?.data ?? { eventIds: [], hiddenEventIds: [] }
    );
  }
  @Put('plot-set')
  @MinimumRole('viewer')
  @SetMetadata('allowViewerWrite', true)
  @DocumentRoute('Save personal plot version references', PlotSetSchema, PlotSetSchema)
  async savePlotSet(@Body() value: unknown, @Req() req: AuthRequest) {
    const set = parse(PlotSetSchema, value);
    if (set.hiddenEventIds.some((id) => !set.eventIds.includes(id)))
      throw new BadRequestException('Hidden event must belong to plot set');
    const found = await this.infra.pool.query(
      'SELECT id FROM intelligence_events WHERE id=ANY($1::text[])',
      [set.eventIds],
    );
    if (found.rows.length !== new Set(set.eventIds).size)
      throw new BadRequestException('Unknown version reference');
    await this.infra.pool.query(
      'INSERT INTO intelligence_plot_sets(user_id,data) VALUES($1,$2::jsonb) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,updated_at=now()',
      [req.user.id, JSON.stringify(set)],
    );
    return set;
  }
}
