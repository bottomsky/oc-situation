import {
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  HttpException,
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
  isPredictionDefinition,
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
import {
  assertPredictionOwner,
  cancelPrediction,
  getPredictionArtifact,
  listPredictions,
  PredictionTaskError,
  requestPrediction,
  setPredictionWatch,
} from '../../../../packages/infrastructure/predictions';
const PredictionRequestSchema = z.strictObject({
  mmsi: z.string().regex(/^[1-9]\d{8}$/),
  watch: z.boolean().optional(),
});
const PredictionListQuerySchema = z.strictObject({
  mmsi: z
    .string()
    .regex(/^[1-9]\d{8}$/)
    .optional(),
});
async function predictionAction<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof PredictionTaskError)) throw error;
    const status = {
      unauthorized: 401,
      not_found: 404,
      conflict: 409,
      capacity: 429,
      invalid_input: 400,
    }[error.category];
    throw new HttpException(
      { code: `PREDICTION_${error.category.toUpperCase()}`, message: error.message },
      status,
    );
  }
}

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
  @Post('predictions')
  @MinimumRole('operator')
  @HttpCode(202)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @DocumentRoute(
    'Queue an owned bounded single-vessel prediction task',
    ObjectResponse,
    PredictionRequestSchema,
    202,
  )
  async predict(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
    @Req() req: AuthRequest,
  ) {
    const input = parse(PredictionRequestSchema, body);
    parse(Uuid, key);
    const result = await predictionAction(() =>
      requestPrediction(this.infra, req.user.id, input, key),
    );
    await audit(this.infra, req.user.id, 'prediction.request', 'topic', result.instanceId, {
      ...input,
      runId: result.runId,
    });
    return result;
  }
  @Get('predictions')
  @DocumentQuery(PredictionListQuerySchema)
  @DocumentRoute(
    'Owned latest prediction metadata, with geometry only for a selected MMSI',
    ObjectResponse,
  )
  predictions(@Query() query: unknown, @Req() req: AuthRequest) {
    const input = parse(PredictionListQuerySchema, query);
    return predictionAction(() => listPredictions(this.infra, req.user.id, input.mmsi));
  }
  @Put('predictions/:instanceId/watch')
  @MinimumRole('operator')
  @DocumentRoute(
    'Persist an owned vessel watch within the twenty-vessel account quota',
    ObjectResponse,
    z.strictObject({ watch: z.boolean() }),
  )
  async watch(@Param('instanceId') id: string, @Body() body: unknown, @Req() req: AuthRequest) {
    parse(Uuid, id);
    const { watch } = parse(z.strictObject({ watch: z.boolean() }), body);
    const result = await predictionAction(() =>
      setPredictionWatch(this.infra, req.user.id, id, watch),
    );
    await audit(this.infra, req.user.id, 'prediction.watch', 'topic', id, { watch });
    return result;
  }
  @Post('predictions/:instanceId/cancel')
  @MinimumRole('operator')
  @HttpCode(200)
  @DocumentRoute('Cancel an owned prediction and fence all in-flight leases', ObjectResponse)
  async cancel(@Param('instanceId') id: string, @Req() req: AuthRequest) {
    parse(Uuid, id);
    const result = await predictionAction(() => cancelPrediction(this.infra, req.user.id, id));
    await audit(this.infra, req.user.id, 'prediction.cancel', 'topic', id, {});
    return result;
  }
  @Get()
  @DocumentRoute(
    'Registered analysis definitions and independently managed instances',
    z.object({
      definitions: z.array(ObjectResponse),
      instances: z.array(ObjectResponse),
      capabilities: ObjectResponse,
    }),
  )
  async list(@Req() req: AuthRequest) {
    return {
      definitions: TOPIC_DEFINITIONS,
      instances: await listTopicInstances(this.infra, req.user.id),
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
    const result = await createTopicInstance(this.infra, value, req.user.id);
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
    await predictionAction(() => assertPredictionOwner(this.infra, id, req.user.id));
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
    await predictionAction(() => assertPredictionOwner(this.infra, id, req.user.id));
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
  async runs(@Param('id') id: string, @Req() req: AuthRequest) {
    parse(Uuid, id);
    await predictionAction(() => assertPredictionOwner(this.infra, id, req.user.id));
    return { items: await listTopicRuns(this.infra, id) };
  }
  @Get('runs/:id')
  @DocumentRoute(
    'Run snapshot including exact input dataset and algorithm configuration',
    ObjectResponse,
  )
  async runDetail(@Param('id') id: string, @Req() req: AuthRequest) {
    parse(Uuid, id);
    const run = await getTopicRun(this.infra, id);
    if (!run) throw new NotFoundException('Topic run not found');
    await predictionAction(() => assertPredictionOwner(this.infra, run.instanceId, req.user.id));
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
    const prediction = await predictionAction(() =>
      assertPredictionOwner(this.infra, id, req.user.id),
    );
    if (prediction && config.mmsi !== prediction.mmsi)
      throw new ConflictException('Prediction MMSI is fixed for the owned instance');
    const result = await updateTopicConfig(this.infra, id, config);
    if (!result) throw new NotFoundException('Topic instance not found');
    await audit(this.infra, req.user.id, 'topic.config', 'topic', id, { config });
    return result;
  }
}

@Controller('analysis')
export class AnalysisController {
  constructor(@Inject(INFRA) private readonly infra: Infrastructure) {}
  @Get('results/:id/artifact')
  @DocumentQuery(z.strictObject({ revision: z.coerce.number().int().positive().optional() }))
  @DocumentRoute(
    'Immutable prediction geometry and warning impacts for one result revision',
    ObjectResponse,
  )
  artifact(@Param('id') id: string, @Query() query: unknown, @Req() req: AuthRequest) {
    parse(ResultId, id);
    const input = parse(
      z.strictObject({ revision: z.coerce.number().int().positive().optional() }),
      query,
    );
    return predictionAction(() =>
      getPredictionArtifact(this.infra, req.user.id, id, input.revision),
    );
  }
  @Get('results')
  @DocumentRoute('Latest analysis results including revisions and withdrawals', ItemsResponse)
  @DocumentQuery(ResultsQuery)
  async list(@Query() query: unknown, @Req() req: AuthRequest) {
    const q = parse(ResultsQuery, query);
    return { items: await listAnalysisResults(this.infra, q.instanceId, q.limit, req.user.id) };
  }
  @Get('results/:id/revisions')
  @DocumentRoute(
    'Immutable result revisions with original AIS and document evidence',
    ItemsResponse,
  )
  async revisions(@Param('id') id: string, @Req() req: AuthRequest) {
    parse(ResultId, id);
    const result = await getAnalysisResult(this.infra, id);
    if (!result) throw new NotFoundException('Analysis result not found');
    if (isPredictionDefinition(result.definitionId))
      await predictionAction(() =>
        assertPredictionOwner(this.infra, result.instanceId, req.user.id),
      );
    return { items: await getAnalysisRevisions(this.infra, id) };
  }
  @Get('results/:id')
  @DocumentRoute('Result with immutable evidence snapshots, rules and limitations', ObjectResponse)
  async detail(@Param('id') id: string, @Req() req: AuthRequest) {
    parse(ResultId, id);
    const result = await getAnalysisResult(this.infra, id);
    if (!result) throw new NotFoundException('Analysis result not found');
    if (isPredictionDefinition(result.definitionId))
      await predictionAction(() =>
        assertPredictionOwner(this.infra, result.instanceId, req.user.id),
      );
    return result;
  }
  @Get('feed')
  @DocumentRoute(
    'Replay durable analysis notifications after a cursor',
    z.object({ items: z.array(ObjectResponse), nextCursor: z.string() }),
  )
  @DocumentQuery(FeedQuery)
  feed(@Query() query: unknown, @Req() req: AuthRequest) {
    const q = parse(FeedQuery, query);
    return readAnalysisFeed(this.infra, q.cursor, q.limit, req.user.id);
  }
}
