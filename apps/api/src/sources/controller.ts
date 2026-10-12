import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Req,
  NotFoundException,
  HttpCode,
} from '@nestjs/common';
import { ApiParam } from '@nestjs/swagger';
import { z } from 'zod';
import { SourceConfigSchema, type SourceConfig } from '@ais/contracts';
import type { Infrastructure } from '@ais/infrastructure';
import {
  DocumentRoute,
  INFRA,
  OPTIONS,
  MinimumRole,
  parse,
  SafeId,
  audit,
  type ApiOptions,
  isoValue,
} from '../common';
import type { AuthRequest } from '../auth/guard';
import { validateSource } from './validation';
export const SourceResponseSchema = SourceConfigSchema.extend({
  lastReceivedAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
});
interface SourceRow {
  id: string;
  kind: SourceConfig['sourceKind'];
  name: string;
  status: string;
  enabled: boolean;
  priority: number;
  secret_ref: string | null;
  config: Pick<SourceConfig, 'endpoint' | 'bbox' | 'settings'>;
  last_received_at?: Date | string | null;
  last_error?: string | null;
}
export function sourceRow(
  r: SourceRow,
): SourceConfig & { lastReceivedAt: string | null; lastError: string | null } {
  return {
    sourceId: r.id,
    sourceKind: r.kind,
    name: r.name,
    status: r.status === 'error' ? 'error' : r.enabled ? 'enabled' : 'disabled',
    priority: r.priority,
    secretRef: r.secret_ref,
    ...r.config,
    lastReceivedAt: r.last_received_at ? isoValue(r.last_received_at) : null,
    lastError: r.last_error ? 'Source request failed; inspect operator logs' : null,
  };
}
@Controller('sources')
export class SourcesController {
  constructor(
    @Inject(INFRA) private readonly infra: Infrastructure,
    @Inject(OPTIONS) private readonly options: ApiOptions,
  ) {}
  @Get()
  @DocumentRoute('Source configurations and receipt health', z.array(SourceResponseSchema))
  async list() {
    const result = await this.infra.pool.query('SELECT * FROM sources ORDER BY id');
    return result.rows.map(sourceRow);
  }
  @Post()
  @MinimumRole('admin')
  @DocumentRoute(
    'Create authorized source configuration',
    SourceResponseSchema,
    SourceConfigSchema,
    201,
  )
  async create(@Body() input: unknown, @Req() req: AuthRequest) {
    const s = validateSource(parse(SourceConfigSchema, input), this.options.production);
    const result = await this.infra.pool.query(
      'INSERT INTO sources(id,name,kind,enabled,priority,config,secret_ref,status) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *',
      this.values(s),
    );
    await audit(this.infra, req.user.id, 'source.create', 'source', s.sourceId, s);
    return sourceRow(result.rows[0]);
  }
  @Put(':sourceId')
  @ApiParam({ name: 'sourceId', type: String })
  @MinimumRole('admin')
  @DocumentRoute('Replace source configuration', SourceResponseSchema, SourceConfigSchema)
  async update(@Param('sourceId') id: string, @Body() input: unknown, @Req() req: AuthRequest) {
    parse(SafeId, id);
    const s = validateSource(parse(SourceConfigSchema, input), this.options.production);
    if (s.sourceId !== id) throw new NotFoundException('Source id mismatch');
    const client = await this.infra.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        'UPDATE sources SET name=$2,kind=$3,enabled=$4,priority=$5,config=$6::jsonb,secret_ref=$7,status=$8,updated_at=now() WHERE id=$1 RETURNING *',
        this.values(s),
      );
      if (!result.rows[0]) throw new NotFoundException('Source not found');
      if (s.status !== 'enabled')
        await client.query(
          "UPDATE runs SET status='cancelled',finished_at=now(),updated_at=now() WHERE source_id=$1 AND status IN ('queued','running')",
          [id],
        );
      await client.query('COMMIT');
      await audit(this.infra, req.user.id, 'source.update', 'source', id, s);
      return sourceRow(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  @Delete(':sourceId')
  @ApiParam({ name: 'sourceId', type: String })
  @HttpCode(204)
  @MinimumRole('admin')
  @DocumentRoute('Delete a source with no referenced jobs or runs', z.null(), undefined, 204)
  async remove(@Param('sourceId') id: string, @Req() req: AuthRequest) {
    parse(SafeId, id);
    const result = await this.infra.pool.query('DELETE FROM sources WHERE id=$1', [id]);
    if (!result.rowCount) throw new NotFoundException('Source not found');
    await audit(this.infra, req.user.id, 'source.delete', 'source', id);
  }
  private values(s: SourceConfig) {
    return [
      s.sourceId,
      s.name,
      s.sourceKind,
      s.status === 'enabled',
      s.priority,
      JSON.stringify({
        ...(s.endpoint ? { endpoint: s.endpoint } : {}),
        ...(s.bbox ? { bbox: s.bbox } : {}),
        ...(s.settings ? { settings: s.settings } : {}),
      }),
      s.secretRef,
      s.status,
    ];
  }
}
