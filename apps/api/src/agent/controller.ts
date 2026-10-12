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
} from '../../../../packages/contracts/agent';
import {
  cancelAgentTask,
  createAgentSession,
  getAgentSession,
  getOwnedAgentTask,
  listAgentSessions,
  readAgentEvents,
  submitAgentMessage,
} from '../../../../packages/infrastructure/agent';
import { DocumentQuery, DocumentRoute, INFRA, MinimumRole, Uuid, parse } from '../common';
import type { AuthRequest } from '../auth/guard';

const ObjectResponse = z.record(z.string(), z.unknown());
const ConfigResponse = z.object({
  enabled: z.boolean(),
  defaultHistoryHours: z.number(),
  maxHistoryHours: z.number(),
  maxModelCalls: z.number(),
  maxToolCalls: z.number(),
});
const SessionResponse = z.object({
  session: AgentSessionSchema,
  messages: z.array(AgentMessageSchema),
  tasks: z.array(AgentTaskSchema),
});
const TaskResponse = z.object({
  task: AgentTaskSchema,
  results: z.array(ObjectResponse),
  steps: z.array(AgentStepSchema),
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
    return createAgentSession(this.infra, req.user.id, parse(AgentSessionInputSchema, body).title);
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
    z.object({ message: AgentMessageSchema, task: AgentTaskSchema }),
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
      throw error;
    }
  }
  @Get('tasks/:id')
  @DocumentRoute('Read owned task, immutable results and tool ledger', TaskResponse)
  async task(@Param('id') id: string, @Req() req: AuthRequest) {
    this.assertEnabled();
    parse(Uuid, id);
    const result = await getOwnedAgentTask(this.infra, req.user.id, id);
    if (!result) throw new NotFoundException('Task not found');
    return { task: result.task, results: result.results, steps: result.steps };
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
