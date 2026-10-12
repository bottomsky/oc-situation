import {
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { z } from 'zod';
import type { Infrastructure } from '@ais/infrastructure';
import {
  CreateTopicInstanceSchema,
  TopicConfigSchema,
  TopicStateSchema,
} from '../../../../packages/contracts/topics';
import { FUSION_CAPABILITIES, TOPIC_DEFINITIONS } from '../../../../packages/domain/topics';
import {
  createTopicInstance,
  getAnalysisResult,
  getAnalysisRevisions,
  getTopicRun,
  listAnalysisResults,
  listTopicInstances,
  listTopicRuns,
  queueTopicRun,
  readAnalysisFeed,
  setTopicState,
  updateTopicConfig,
} from '../../../../packages/infrastructure/topics';
import { DocumentQuery, DocumentRoute, INFRA, MinimumRole, Uuid, audit, parse } from '../common';
import type { AuthRequest } from '../auth/guard';

const ObjectResponse = z.record(z.string(), z.unknown());
const ItemsResponse = z.object({ items: z.array(ObjectResponse) });
const ResultId = z.string().regex(/^[a-f0-9]{64}$/);
const ResultsQuery = z.strictObject({
  instanceId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const FeedQuery = z.strictObject({
  cursor: z
    .string()
    .regex(/^\d{1,18}$/)
    .default('0'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

@Controller('topics')
export class TopicsController {
  constructor(@Inject(INFRA) private readonly infra: Infrastructure) {}
  @Get()
  @DocumentRoute(
    'Registered analysis definitions and independently managed instances',
    z.object({
      definitions: z.array(ObjectResponse),
      instances: z.array(ObjectResponse),
      capabilities: ObjectResponse,
    }),
  )
  async list() {
    return {
      definitions: TOPIC_DEFINITIONS,
      instances: await listTopicInstances(this.infra),
      capabilities: FUSION_CAPABILITIES,
    };
  }
  @Post('instances')
  @MinimumRole('admin')
  @DocumentRoute(
    'Create a durable topic instance; enabling schedules historical warmup',
    ObjectResponse,
    CreateTopicInstanceSchema,
    201,
  )
  async create(@Body() body: unknown, @Req() req: AuthRequest) {
    const value = parse(CreateTopicInstanceSchema, body);
    const result = await createTopicInstance(this.infra, value);
    await audit(this.infra, req.user.id, 'topic.create', 'topic', result.id, value);
    return result;
  }
  @Put('instances/:id/state')
  @MinimumRole('admin')
  @DocumentRoute(
    'Enable or disable a topic and fence earlier generation work',
    ObjectResponse,
    TopicStateSchema,
  )
  async state(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthRequest) {
    parse(Uuid, id);
    const { enabled } = parse(TopicStateSchema, body);
    const result = await setTopicState(this.infra, id, enabled);
    if (!result) throw new NotFoundException('Topic instance not found');
    await audit(this.infra, req.user.id, 'topic.state', 'topic', id, { enabled });
    return result;
  }
  @Post('instances/:id/run')
  @HttpCode(202)
  @MinimumRole('operator')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @DocumentRoute('Queue an idempotent durable manual analysis run', ObjectResponse, undefined, 202)
  async run(
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Req() req: AuthRequest,
  ) {
    parse(Uuid, id);
    parse(Uuid, key);
    let result;
    try {
      result = await queueTopicRun(this.infra, id, `manual:${key}`);
    } catch (error) {
      if (error instanceof Error && error.message === 'Topic instance is disabled')
        throw new ConflictException(error.message);
      throw error;
    }
    if (!result) throw new NotFoundException('Topic instance not found');
    await audit(this.infra, req.user.id, 'topic.run', 'topic', id, { runId: result.id });
    return result;
  }
  @Get('instances/:id/runs')
  @DocumentRoute('Recent topic execution history', ItemsResponse)
  async runs(@Param('id') id: string) {
    parse(Uuid, id);
    return { items: await listTopicRuns(this.infra, id) };
  }
  @Get('runs/:id')
  @DocumentRoute(
    'Run snapshot including exact input dataset and algorithm configuration',
    ObjectResponse,
  )
  async runDetail(@Param('id') id: string) {
    parse(Uuid, id);
    const run = await getTopicRun(this.infra, id);
    if (!run) throw new NotFoundException('Topic run not found');
    return run;
  }
  @Put('instances/:id/config')
  @MinimumRole('admin')
  @DocumentRoute(
    'Update configuration and restart historical warmup with a fenced generation',
    ObjectResponse,
    z.strictObject({ config: TopicConfigSchema }),
  )
  async config(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthRequest) {
    parse(Uuid, id);
    const { config } = parse(z.strictObject({ config: TopicConfigSchema }), body);
    const result = await updateTopicConfig(this.infra, id, config);
    if (!result) throw new NotFoundException('Topic instance not found');
    await audit(this.infra, req.user.id, 'topic.config', 'topic', id, { config });
    return result;
  }
}

@Controller('analysis')
export class AnalysisController {
  constructor(@Inject(INFRA) private readonly infra: Infrastructure) {}
  @Get('results')
  @DocumentRoute('Latest analysis results including revisions and withdrawals', ItemsResponse)
  @DocumentQuery(ResultsQuery)
  async list(@Query() query: unknown) {
    const q = parse(ResultsQuery, query);
    return { items: await listAnalysisResults(this.infra, q.instanceId, q.limit) };
  }
  @Get('results/:id/revisions')
  @DocumentRoute(
    'Immutable result revisions with original AIS and document evidence',
    ItemsResponse,
  )
  async revisions(@Param('id') id: string) {
    parse(ResultId, id);
    if (!(await getAnalysisResult(this.infra, id)))
      throw new NotFoundException('Analysis result not found');
    return { items: await getAnalysisRevisions(this.infra, id) };
  }
  @Get('results/:id')
  @DocumentRoute('Result with immutable evidence snapshots, rules and limitations', ObjectResponse)
  async detail(@Param('id') id: string) {
    parse(ResultId, id);
    const result = await getAnalysisResult(this.infra, id);
    if (!result) throw new NotFoundException('Analysis result not found');
    return result;
  }
  @Get('feed')
  @DocumentRoute(
    'Replay durable analysis notifications after a cursor',
    z.object({ items: z.array(ObjectResponse), nextCursor: z.string() }),
  )
  @DocumentQuery(FeedQuery)
  feed(@Query() query: unknown) {
    const q = parse(FeedQuery, query);
    return readAnalysisFeed(this.infra, q.cursor, q.limit);
  }
}
