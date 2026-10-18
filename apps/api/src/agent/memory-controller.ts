import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  SetMetadata,
} from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { z } from 'zod';
import type { Infrastructure } from '@ais/infrastructure';
import {
  AgentMemorySettingsUpdateSchema,
  AgentMemorySourceSchema,
  AgentSessionMemoryResetSchema,
  AgentMemoryReferenceSchema,
  AgentMemoryValueSchema,
} from '../../../../packages/contracts/agent-memory';
import {
  AgentMemoryError,
  agentMemoryFeatures,
  getAgentAccountMemory,
  getAgentMemorySettings,
  getAgentSessionMemory,
  getLatestAgentSessionMemoryContext,
  mutateAgentAccountMemory,
  resetAgentSessionMemory,
  updateAgentMemorySettings,
} from '../../../../packages/infrastructure/agent-memory';
import { DocumentRoute, INFRA, parse, Uuid } from '../common';
import type { AuthRequest } from '../auth/guard';

const Revision = z.number().int().nonnegative();
const Mutation = AgentSessionMemoryResetSchema;
const Save = Mutation.extend({
  category: z.string().trim().min(1).max(100),
  key: z.string().trim().min(1).max(200),
  value: AgentMemoryValueSchema,
});
const Features = z.object({ session: z.boolean(), account: z.boolean(), proposals: z.boolean() });
const Settings = z.object({
  readEnabled: z.boolean(),
  proposalsEnabled: z.boolean(),
  generation: Revision,
  revision: Revision,
  features: Features,
});
const Entry = z.object({
  id: z.uuid(),
  category: z.string(),
  key: z.string(),
  value: z.json(),
  status: z.enum(['active', 'proposed']),
  source: AgentMemorySourceSchema,
  revision: Revision,
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string().nullable(),
});
const Account = z.object({ revision: Revision, entries: z.array(Entry) });
const SessionView = z.object({
  sessionId: z.uuid(),
  revision: Revision,
  turnSeq: Revision,
  generation: Revision,
  summary: z.string(),
  conditions: z.record(z.string(), z.json()),
  references: z.array(AgentMemoryReferenceSchema),
  updatedAt: z.string(),
  objectSets: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      kind: z.string(),
      memberCount: Revision,
      turnSeq: Revision,
      source: AgentMemorySourceSchema,
    }),
  ),
  appliedAccountMemories: z.array(Entry),
  appliedTaskId: z.uuid().nullable(),
  features: Features,
});

@Controller('agent')
@SetMetadata('allowViewerWrite', true)
@ApiResponse({
  status: 409,
  description: 'Memory revision or operationId conflicts; refresh before retrying',
})
export class AgentMemoryController {
  constructor(@Inject(INFRA) private readonly infra: Infrastructure) {}
  private async execute<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof AgentMemoryError)) throw error;
      if (error.code === 'NOT_FOUND') throw new NotFoundException(error.message);
      if (error.code === 'WRITE_DISABLED') throw new ForbiddenException(error.message);
      if (error.code === 'INVALID_OPERATION') throw new BadRequestException(error.message);
      throw new ConflictException(error.message);
    }
  }
  private assertAccountEnabled() {
    if (!agentMemoryFeatures().account)
      throw new ForbiddenException('账号记忆使用已由系统暂停，可继续查看、删除和清空记录。');
  }
  @Get('memories')
  @DocumentRoute('读取当前账号的正式记忆和待确认候选', Account)
  list(@Req() req: AuthRequest) {
    return this.execute(() =>
      getAgentAccountMemory(this.infra, req.user.id, { includeProposed: true }),
    );
  }
  @Get('memories/settings')
  @DocumentRoute('读取个人记忆设置与系统可用性', Settings)
  async settings(@Req() req: AuthRequest) {
    return {
      ...(await getAgentMemorySettings(this.infra, req.user.id)),
      features: agentMemoryFeatures(),
    };
  }
  @Put('memories/settings')
  @DocumentRoute('更新个人读取与自动候选提取设置', Settings, AgentMemorySettingsUpdateSchema)
  async setSettings(@Body() body: unknown, @Req() req: AuthRequest) {
    const input = parse(AgentMemorySettingsUpdateSchema, body);
    return {
      ...(await this.execute(() => updateAgentMemorySettings(this.infra, req.user.id, input))),
      features: agentMemoryFeatures(),
    };
  }
  @Post('memories')
  @HttpCode(200)
  @DocumentRoute('明确保存一条个人记忆', Account, Save)
  async create(@Body() body: unknown, @Req() req: AuthRequest) {
    this.assertAccountEnabled();
    const input = parse(Save, body);
    return this.execute(() =>
      mutateAgentAccountMemory(this.infra, req.user.id, {
        ...input,
        action: 'remember',
        source: { description: '账号手动维护' },
      }),
    );
  }
  @Put('memories/:id')
  @DocumentRoute('编辑个人记忆并校验目录修订', Account, Save)
  async update(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthRequest) {
    this.assertAccountEnabled();
    parse(Uuid, id);
    const input = parse(Save, body);
    return this.execute(() =>
      mutateAgentAccountMemory(this.infra, req.user.id, {
        ...input,
        action: 'remember',
        entryId: id,
        source: { description: '账号手动维护' },
      }),
    );
  }
  @Post('memories/:id/confirm')
  @HttpCode(200)
  @DocumentRoute('将待确认候选纳入个人记忆', Account, Mutation)
  async confirm(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthRequest) {
    this.assertAccountEnabled();
    parse(Uuid, id);
    const input = parse(Mutation, body);
    return this.execute(() =>
      mutateAgentAccountMemory(this.infra, req.user.id, {
        ...input,
        action: 'accept',
        entryId: id,
      }),
    );
  }
  @Post('memories/:id/dismiss')
  @HttpCode(200)
  @DocumentRoute('拒绝候选并移除候选正文', Account, Mutation)
  async dismiss(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthRequest) {
    parse(Uuid, id);
    const input = parse(Mutation, body);
    return this.execute(() =>
      mutateAgentAccountMemory(this.infra, req.user.id, {
        ...input,
        action: 'reject',
        entryId: id,
      }),
    );
  }
  @Delete('memories/:id')
  @DocumentRoute('遗忘一条个人记忆', Account, Mutation)
  async remove(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthRequest) {
    parse(Uuid, id);
    const input = parse(Mutation, body);
    return this.execute(() =>
      mutateAgentAccountMemory(this.infra, req.user.id, {
        ...input,
        action: 'delete',
        entryId: id,
      }),
    );
  }
  @Delete('memories')
  @DocumentRoute('清空当前账号正式记忆和候选', Account, Mutation)
  async clear(@Body() body: unknown, @Req() req: AuthRequest) {
    const input = parse(Mutation, body);
    return this.execute(() =>
      mutateAgentAccountMemory(this.infra, req.user.id, { ...input, action: 'clear' }),
    );
  }
  @Get('sessions/:id/memory')
  @DocumentRoute('读取私有会话的讨论对象摘要和最近一轮检索记忆', SessionView)
  async session(@Param('id') id: string, @Req() req: AuthRequest) {
    parse(Uuid, id);
    const memory = await getAgentSessionMemory(this.infra, req.user.id, id);
    if (!memory) throw new NotFoundException('Session not found');
    const snapshot = await getLatestAgentSessionMemoryContext(this.infra, req.user.id, id);
    return {
      sessionId: memory.sessionId,
      revision: memory.revision,
      turnSeq: memory.turnSeq,
      generation: memory.generation,
      summary: memory.summary,
      conditions: memory.conditions,
      references: memory.references,
      updatedAt: memory.updatedAt,
      objectSets: memory.objectSets.map((set) => ({
        id: set.id,
        label: set.label,
        kind: set.kind,
        memberCount: set.members.length,
        turnSeq: set.turnSeq,
        source: set.source,
      })),
      appliedAccountMemories: snapshot?.account ?? [],
      appliedTaskId: snapshot?.taskId ?? null,
      features: agentMemoryFeatures(),
    };
  }
  @Delete('sessions/:id/memory')
  @DocumentRoute(
    '重置私有会话讨论对象和上下文',
    SessionView.omit({ appliedAccountMemories: true, appliedTaskId: true, features: true }),
    Mutation,
  )
  async resetSession(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthRequest) {
    parse(Uuid, id);
    const input = parse(AgentSessionMemoryResetSchema, body);
    const memory = await this.execute(() =>
      resetAgentSessionMemory(this.infra, req.user.id, id, input),
    );
    return {
      ...memory,
      objectSets: memory.objectSets.map((set) => ({
        id: set.id,
        label: set.label,
        kind: set.kind,
        memberCount: set.members.length,
        turnSeq: set.turnSeq,
        source: set.source,
      })),
    };
  }
}
