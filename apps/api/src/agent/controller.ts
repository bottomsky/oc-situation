import { AgentVesselTracksResultSchema } from '../../../../packages/contracts/vessel-tracks';
import { AgentIntelligenceResultSchema } from '../../../../packages/contracts/intelligence-search';
import { AgentHeatmapResultSchema } from '../../../../packages/contracts/heatmap';
import {
  DynamicSkillArtifactSchema,
  DynamicSkillExecutionSchema,
} from '../../../../packages/contracts/dynamic-skills';
import { DynamicSkillError } from '../../../../packages/infrastructure/dynamic-skills';
import {
  Body,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { z } from 'zod';
import type { Infrastructure } from '@ais/infrastructure';
import {
  AgentEventsQuerySchema,
  AgentEventSchema,
  AgentMessageInputSchema,
  AgentMessageSchema,
  AgentSessionInputSchema,
  AgentSessionSchema,
  AgentStepSchema,
  AgentTaskSchema,
  AgentInputRequestSchema,
  AgentInputResponseSchema,
  AgentQueryResultSchema,
  AgentRetryInputSchema,
} from '../../../../packages/contracts/agent';
import {
  cancelAgentTask,
  createAgentSession,
  getAgentSession,
  getOwnedAgentTask,
  listAgentSessions,
  readAgentEvents,
  submitAgentMessage,
  respondAgentInput,
  retryAgentTask,
  AgentInputError,
} from '../../../../packages/infrastructure/agent';
import { DocumentQuery, DocumentRoute, INFRA, MinimumRole, Uuid, parse } from '../common';
import type { AuthRequest } from '../auth/guard';

const ObjectResponse = z.record(z.string(), z.unknown());
const TaskQuery = z.strictObject({
  resultVersion: z.coerce.number().int().positive().optional(),
  inputRevision: z.coerce.number().int().nonnegative().optional(),
});
const ConfigResponse = z.object({
  enabled: z.boolean(),
  uiEnabled: z.boolean(),
  dynamicSkillsEnabled: z.boolean(),
  defaultHistoryHours: z.number(),
  maxHistoryHours: z.number(),
  maxModelCalls: z.number(),
  maxToolCalls: z.number(),
});
const SessionResponse = z.object({
  session: AgentSessionSchema,
  messages: z.array(AgentMessageSchema),
  tasks: z.array(AgentTaskSchema),
  pendingInputRequests: z.array(AgentInputRequestSchema),
  snapshotCursor: z.string(),
});
const TaskResponse = z.object({
  task: AgentTaskSchema,
  results: z.array(ObjectResponse),
  steps: z.array(AgentStepSchema),
  pendingInputRequests: z.array(AgentInputRequestSchema),
  snapshotCursor: z.string(),
  queryResult: AgentQueryResultSchema.nullable(),
  intelligenceResult: AgentIntelligenceResultSchema.nullable(),
  heatmapResult: AgentHeatmapResultSchema.nullable(),
  tracksResult: AgentVesselTracksResultSchema.nullable(),
  dynamicSkill: DynamicSkillExecutionSchema,
  artifacts: z.array(DynamicSkillArtifactSchema),
});
const budget = (key: string, fallback: number) => {
  const value = Number(process.env[key] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

@Controller('agent')
export class AgentController {
  constructor(@Inject(INFRA) private readonly infra: Infrastructure) {}
  private assertEnabled() {
    if (process.env.AGENT_ENABLED !== 'true') throw new NotFoundException('Agent feature disabled');
  }
  @Get('config')
  @DocumentRoute('Agent availability and bounded execution defaults', ConfigResponse)
  config() {
    return {
      enabled: process.env.AGENT_ENABLED === 'true',
      uiEnabled: process.env.AGENT_UI_ENABLED === 'true',
      dynamicSkillsEnabled: process.env.AGENT_DYNAMIC_SKILLS_ENABLED === 'true',
      defaultHistoryHours: 24,
      maxHistoryHours: 168,
      maxModelCalls: budget('AGENT_MAX_MODEL_CALLS', 12),
      maxToolCalls: budget('AGENT_MAX_TOOL_CALLS', 24),
    };
  }
  @Get('sessions')
  @DocumentRoute(
    'List sessions owned by the current user',
    z.object({ items: z.array(AgentSessionSchema) }),
  )
  async sessions(@Req() req: AuthRequest) {
    this.assertEnabled();
    return { items: await listAgentSessions(this.infra, req.user.id) };
  }
  @Post('sessions')
  @MinimumRole('operator')
  @DocumentRoute(
    'Create a private analysis conversation',
    AgentSessionSchema,
    AgentSessionInputSchema,
    201,
  )
  async createSession(@Body() body: unknown, @Req() req: AuthRequest) {
    this.assertEnabled();
    const input = parse(AgentSessionInputSchema, body);
    try {
      return await createAgentSession(this.infra, req.user.id, input.title);
    } catch (error) {
      return this.inputError(error);
    }
  }
  @Get('sessions/:id')
  @DocumentRoute('Read a private conversation and its tasks', SessionResponse)
  async session(@Param('id') id: string, @Req() req: AuthRequest) {
    this.assertEnabled();
    parse(Uuid, id);
    const result = await getAgentSession(this.infra, req.user.id, id);
    if (!result) throw new NotFoundException('Session not found');
    return result;
  }
  @Post('sessions/:id/messages')
  @HttpCode(202)
  @MinimumRole('operator')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @DocumentRoute(
    'Submit an idempotent message and queue one independent analysis',
    z.object({
      message: AgentMessageSchema,
      task: AgentTaskSchema,
      pendingInputRequests: z.array(AgentInputRequestSchema),
    }),
    AgentMessageInputSchema,
    202,
  )
  async message(
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
    @Req() req: AuthRequest,
  ) {
    this.assertEnabled();
    parse(Uuid, id);
    parse(Uuid, key);
    const input = parse(AgentMessageInputSchema, body);
    if (!(await getAgentSession(this.infra, req.user.id, id)))
      throw new NotFoundException('Session not found');
    try {
      return await submitAgentMessage(this.infra, req.user.id, id, key, input);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Idempotency'))
        throw new ConflictException(error.message);
      return this.inputError(error);
    }
  }
  @Get('tasks/:id')
  @DocumentQuery(TaskQuery)
  @DocumentRoute('Read owned task, immutable results and tool ledger', TaskResponse)
  async task(@Param('id') id: string, @Req() req: AuthRequest, @Query() query: unknown = {}) {
    this.assertEnabled();
    parse(Uuid, id);
    const { resultVersion, inputRevision } = parse(TaskQuery, query);
    if (resultVersion !== undefined && inputRevision !== undefined)
      throw new BadRequestException('请选择结果版本或输入修订中的一种读取方式');
    const result = await getOwnedAgentTask(
      this.infra,
      req.user.id,
      id,
      resultVersion,
      inputRevision,
    );
    if (!result) throw new NotFoundException('Task not found');
    return {
      task: result.task,
      results: result.results,
      steps: result.steps,
      pendingInputRequests: result.pendingInputRequests,
      snapshotCursor: result.snapshotCursor,
      queryResult: result.queryResult,
      intelligenceResult: result.intelligenceResult,
      heatmapResult: result.heatmapResult,
      tracksResult: result.tracksResult,
      dynamicSkill: result.dynamicSkill,
      artifacts: result.artifacts,
    };
  }
  private inputError(error: unknown): never {
    if (error instanceof AgentInputError || error instanceof DynamicSkillError) {
      const body = { code: error.code, message: error.message };
      if (error.code === 'not_found') throw new NotFoundException(body);
      if (error.code === 'forbidden') throw new ForbiddenException(body);
      if (error.code === 'invalid_input') throw new BadRequestException(body);
      throw new ConflictException(body);
    }
    throw error;
  }
  @Post('tasks/:id/input-requests/:requestId/responses')
  @HttpCode(200)
  @MinimumRole('operator')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @DocumentRoute(
    'Answer a persisted input request and resume the same task',
    z.object({ task: AgentTaskSchema, request: AgentInputRequestSchema }),
    AgentInputResponseSchema,
  )
  async respond(
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
    @Req() req: AuthRequest,
  ) {
    this.assertEnabled();
    parse(Uuid, id);
    parse(Uuid, requestId);
    parse(Uuid, key);
    const input = parse(AgentInputResponseSchema, body);
    try {
      return await respondAgentInput(this.infra, req.user.id, id, requestId, key, input);
    } catch (error) {
      return this.inputError(error);
    }
  }
  @Post('tasks/:id/retry')
  @HttpCode(202)
  @MinimumRole('operator')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @DocumentRoute(
    'Create a visible new attempt with confirmed inputs and an independent budget',
    z.object({ task: AgentTaskSchema, message: AgentMessageSchema }),
    AgentRetryInputSchema,
    202,
  )
  async retry(
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
    @Req() req: AuthRequest,
  ) {
    this.assertEnabled();
    parse(Uuid, id);
    parse(Uuid, key);
    const input = parse(AgentRetryInputSchema, body);
    try {
      return await retryAgentTask(
        this.infra,
        req.user.id,
        id,
        key,
        input.uiBinding,
        input.skillVersionPolicy ?? 'original',
      );
    } catch (error) {
      return this.inputError(error);
    }
  }
  @Post('tasks/:id/cancel')
  @HttpCode(200)
  @MinimumRole('operator')
  @DocumentRoute('Cancel an owned task and fence late results', AgentTaskSchema)
  async cancel(@Param('id') id: string, @Req() req: AuthRequest) {
    this.assertEnabled();
    parse(Uuid, id);
    const result = await cancelAgentTask(this.infra, req.user.id, id);
    if (!result) throw new NotFoundException('Task not found');
    return result;
  }
  @Get('sessions/:id/events')
  @DocumentQuery(AgentEventsQuerySchema)
  @DocumentRoute(
    'Recover persisted conversation events after a cursor',
    z.object({ items: z.array(AgentEventSchema), nextCursor: z.string() }),
  )
  async events(@Param('id') id: string, @Query() query: unknown, @Req() req: AuthRequest) {
    this.assertEnabled();
    parse(Uuid, id);
    const { cursor, limit } = parse(AgentEventsQuerySchema, query);
    const result = await readAgentEvents(this.infra, req.user.id, id, cursor, limit);
    if (!result) throw new NotFoundException('Session not found');
    return result;
  }
}
