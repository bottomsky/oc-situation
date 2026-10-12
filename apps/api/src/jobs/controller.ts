import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ApiHeader, ApiParam } from '@nestjs/swagger';
import { z } from 'zod';
import { JobConfigSchema } from '@ais/contracts';
import type { Infrastructure } from '@ais/infrastructure';
import { DocumentRoute, INFRA, MinimumRole, Uuid, parse, audit } from '../common';
import type { AuthRequest } from '../auth/guard';
import { JobsService } from './service';
import { RunResponseSchema } from '../runs/controller';
export const CreateJobSchema = JobConfigSchema.extend({
  jobId: Uuid.optional(),
  scheduleSeconds: JobConfigSchema.shape.scheduleSeconds.optional(),
});
export const JobSchema = JobConfigSchema.extend({ jobId: Uuid });
interface JobRow {
  id: string;
  source_id: string;
  name: string;
  mode: string;
  status: string;
  schedule_seconds: number | null;
}
export function jobRow(r: JobRow) {
  return {
    jobId: r.id,
    sourceId: r.source_id,
    name: r.name,
    mode: r.mode,
    status: r.status,
    scheduleSeconds: r.schedule_seconds,
  };
}
@Controller('jobs')
export class JobsController {
  constructor(
    @Inject(INFRA) private readonly infra: Infrastructure,
    @Inject(JobsService) private readonly service: JobsService,
  ) {}
  @Get()
  @DocumentRoute('Scheduled and manual job configurations', z.array(JobSchema))
  async list() {
    return (await this.infra.pool.query('SELECT * FROM jobs ORDER BY created_at')).rows.map(jobRow);
  }
  @Post()
  @MinimumRole('admin')
  @DocumentRoute(
    'Create a job; null schedule means manual dispatch',
    JobSchema,
    CreateJobSchema,
    201,
  )
  async create(@Body() body: unknown, @Req() req: AuthRequest) {
    const q = parse(CreateJobSchema, body);
    let seconds = q.scheduleSeconds;
    if (seconds === undefined) {
      const source = await this.infra.pool.query('SELECT kind FROM sources WHERE id=$1', [
        q.sourceId,
      ]);
      if (!source.rows[0]) throw new NotFoundException('Source not found');
      seconds = source.rows[0].kind === 'marinetraffic' ? 60 : q.mode === 'crawl' ? 900 : 60;
    }
    const result = await this.infra.pool.query(
      'INSERT INTO jobs(id,source_id,name,mode,status,enabled,schedule_seconds) VALUES(coalesce($1::uuid,gen_random_uuid()),$2,$3,$4,$5,$6,$7) RETURNING *',
      [q.jobId ?? null, q.sourceId, q.name, q.mode, q.status, q.status === 'enabled', seconds],
    );
    await audit(this.infra, req.user.id, 'job.create', 'job', result.rows[0].id, q);
    return jobRow(result.rows[0]);
  }
  @Put(':jobId')
  @ApiParam({ name: 'jobId', format: 'uuid' })
  @MinimumRole('admin')
  @DocumentRoute('Replace job configuration', JobSchema, JobSchema)
  async update(@Param('jobId') id: string, @Body() body: unknown, @Req() req: AuthRequest) {
    parse(Uuid, id);
    const q = parse(JobSchema, body);
    if (q.jobId !== id) throw new NotFoundException('Job id mismatch');
    const result = await this.infra.pool.query(
      'UPDATE jobs SET source_id=$2,name=$3,mode=$4,status=$5,enabled=$6,schedule_seconds=$7,updated_at=now() WHERE id=$1 RETURNING *',
      [id, q.sourceId, q.name, q.mode, q.status, q.status === 'enabled', q.scheduleSeconds],
    );
    if (!result.rows[0]) throw new NotFoundException('Job not found');
    await audit(this.infra, req.user.id, 'job.update', 'job', id, q);
    return jobRow(result.rows[0]);
  }
  @Post(':jobId/run')
  @ApiParam({ name: 'jobId', format: 'uuid' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @HttpCode(202)
  @MinimumRole('operator')
  @DocumentRoute('Queue durable run and outbox command', RunResponseSchema, undefined, 202)
  async run(
    @Param('jobId') id: string,
    @Headers('idempotency-key') key: string,
    @Req() req: AuthRequest,
  ) {
    parse(Uuid, id);
    parse(Uuid, key);
    const result = await this.service.dispatch(id, key);
    await audit(this.infra, req.user.id, 'job.run', 'job', id, { runId: result.runId });
    return result;
  }
  @Post(':jobId/pause')
  @ApiParam({ name: 'jobId', format: 'uuid' })
  @MinimumRole('operator')
  @HttpCode(200)
  @DocumentRoute('Pause future job scheduling', JobSchema)
  pause(@Param('jobId') id: string, @Req() req: AuthRequest) {
    return this.status(id, 'paused', req);
  }
  @Post(':jobId/resume')
  @ApiParam({ name: 'jobId', format: 'uuid' })
  @MinimumRole('operator')
  @HttpCode(200)
  @DocumentRoute('Resume future job scheduling', JobSchema)
  resume(@Param('jobId') id: string, @Req() req: AuthRequest) {
    return this.status(id, 'enabled', req);
  }
  @Delete(':jobId')
  @ApiParam({ name: 'jobId', format: 'uuid' })
  @MinimumRole('admin')
  @HttpCode(204)
  @DocumentRoute('Delete job without referenced run history', z.null(), undefined, 204)
  async remove(@Param('jobId') id: string, @Req() req: AuthRequest) {
    parse(Uuid, id);
    const result = await this.infra.pool.query('DELETE FROM jobs WHERE id=$1', [id]);
    if (!result.rowCount) throw new NotFoundException('Job not found');
    await audit(this.infra, req.user.id, 'job.delete', 'job', id);
  }
  private async status(id: string, status: string, req: AuthRequest) {
    parse(Uuid, id);
    const client = await this.infra.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        'UPDATE jobs SET status=$2,enabled=$3,updated_at=now() WHERE id=$1 RETURNING *',
        [id, status, status === 'enabled'],
      );
      if (!result.rows[0]) throw new NotFoundException('Job not found');
      if (status === 'paused')
        await client.query(
          "UPDATE runs SET status='cancelled',finished_at=now(),updated_at=now() WHERE job_id=$1 AND status IN ('queued','running')",
          [id],
        );
      await client.query('COMMIT');
      await audit(this.infra, req.user.id, `job.${status}`, 'job', id);
      return jobRow(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
