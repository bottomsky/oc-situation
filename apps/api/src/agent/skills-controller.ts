import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import type { Infrastructure } from '@ais/infrastructure';
import {
  DynamicSkillCatalogSchema,
  DynamicSkillDetailSchema,
  DynamicSkillMutationSchema,
  DynamicSkillSummarySchema,
  DynamicSkillVersionSchema,
  PublishDynamicSkillSchema,
  RevokeDynamicSkillVersionSchema,
  SetDynamicSkillEnabledSchema,
} from '../../../../packages/contracts/dynamic-skills';
import {
  activateOwnedSkillVersion,
  DynamicSkillError,
  getOwnedSkill,
  getOwnedSkillVersion,
  listOwnedSkills,
  publishOwnedSkill,
  revokeOwnedSkillVersion,
  setOwnedSkillEnabled,
} from '../../../../packages/infrastructure/dynamic-skills';
import { DocumentRoute, INFRA, MinimumRole, parse, SafeId } from '../common';
import type { AuthRequest } from '../auth/guard';

const MutationResponse = z.object({
  catalogRevision: z.number().int().nonnegative(),
  skill: DynamicSkillSummarySchema,
});
const PublishResponse = MutationResponse.extend({ version: DynamicSkillVersionSchema });

@Controller('agent/skills')
export class SkillsController {
  constructor(@Inject(INFRA) private readonly infra: Infrastructure) {}
  private assertEnabled() {
    if (process.env.AGENT_DYNAMIC_SKILLS_ENABLED !== 'true')
      throw new ForbiddenException('账号动态技能发布与加载尚未启用');
  }
  private async execute<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof DynamicSkillError)) throw error;
      if (error.code === 'not_found') throw new NotFoundException(error.message);
      if (error.code === 'forbidden' || error.code === 'fenced')
        throw new ForbiddenException(error.message);
      if (error.code === 'invalid_input' || error.code === 'configuration')
        throw new BadRequestException(error.message);
      throw new ConflictException(error.message);
    }
  }
  @Get()
  @DocumentRoute(
    'Read the current account private skill catalog, including disabled history',
    DynamicSkillCatalogSchema,
  )
  list(@Req() req: AuthRequest) {
    return listOwnedSkills(this.infra, req.user.id);
  }

  @Get(':id')
  @DocumentRoute('Read one owned skill and all immutable versions', DynamicSkillDetailSchema)
  async detail(@Param('id') id: string, @Req() req: AuthRequest) {
    parse(SafeId, id);
    const result = await getOwnedSkill(this.infra, req.user.id, id);
    if (!result) throw new NotFoundException('Skill not found');
    return result;
  }
  @Get(':id/versions/:version')
  @DocumentRoute('Read an owned immutable skill version', DynamicSkillVersionSchema)
  async version(
    @Param('id') id: string,
    @Param('version') version: string,
    @Req() req: AuthRequest,
  ) {
    parse(SafeId, id);
    parse(SafeId, version);
    const result = await getOwnedSkillVersion(this.infra, req.user.id, id, version);
    if (!result) throw new NotFoundException('Skill version not found');
    return result;
  }
  @Post('publish')
  @HttpCode(200)
  @MinimumRole('operator')
  @DocumentRoute(
    'Validate and idempotently publish a private skill version',
    PublishResponse,
    PublishDynamicSkillSchema,
  )
  async publish(@Body() body: unknown, @Req() req: AuthRequest) {
    this.assertEnabled();
    const input = parse(PublishDynamicSkillSchema, body);
    return this.execute(() => publishOwnedSkill(this.infra, req.user.id, input));
  }
  @Put(':id/state')
  @MinimumRole('operator')
  @DocumentRoute(
    'Enable or disable an owned skill with catalog revision protection',
    MutationResponse,
    SetDynamicSkillEnabledSchema,
  )
  async state(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthRequest) {
    this.assertEnabled();
    parse(SafeId, id);
    const input = parse(SetDynamicSkillEnabledSchema, body);
    return this.execute(() => setOwnedSkillEnabled(this.infra, req.user.id, id, input));
  }
  @Post(':id/versions/:version/activate')
  @HttpCode(200)
  @MinimumRole('operator')
  @DocumentRoute(
    'Activate one non-revoked private skill version',
    MutationResponse,
    DynamicSkillMutationSchema,
  )
  async activate(
    @Param('id') id: string,
    @Param('version') version: string,
    @Body() body: unknown,
    @Req() req: AuthRequest,
  ) {
    this.assertEnabled();
    parse(SafeId, id);
    parse(SafeId, version);
    const input = parse(DynamicSkillMutationSchema, body);
    return this.execute(() =>
      activateOwnedSkillVersion(this.infra, req.user.id, id, version, input),
    );
  }
  @Post(':id/versions/:version/revoke')
  @HttpCode(200)
  @MinimumRole('operator')
  @DocumentRoute(
    'Revoke an owned version while preserving its task history',
    MutationResponse,
    RevokeDynamicSkillVersionSchema,
  )
  async revoke(
    @Param('id') id: string,
    @Param('version') version: string,
    @Body() body: unknown,
    @Req() req: AuthRequest,
  ) {
    this.assertEnabled();
    parse(SafeId, id);
    parse(SafeId, version);
    const input = parse(RevokeDynamicSkillVersionSchema, body);
    return this.execute(() => revokeOwnedSkillVersion(this.infra, req.user.id, id, version, input));
  }
}
