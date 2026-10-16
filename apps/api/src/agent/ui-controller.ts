import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import type { Infrastructure } from '@ais/infrastructure';
import {
  UiBindingSchema,
  UiCommandSchema,
  UiRegisterSchema,
  UiUpdateSchema,
  UiReceiptSchema,
} from '../../../../packages/contracts/agent-ui';
import {
  registerUiClient,
  updateUiState,
  listUiCommands,
  claimUiCommand,
  receiptUiCommand,
} from '../../../../packages/infrastructure/agent-ui';
import { AgentInputError } from '../../../../packages/infrastructure/agent';
import { DocumentRoute, INFRA, MinimumRole, parse, Uuid } from '../common';
import type { AuthRequest } from '../auth/guard';

@Controller('agent/ui')
@MinimumRole('operator')
export class AgentUiController {
  constructor(@Inject(INFRA) private readonly infra: Infrastructure) {}
  private async run<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (e) {
      if (e instanceof AgentInputError) {
        if (e.code === 'forbidden') throw new ForbiddenException(e.message);
        if (e.code === 'not_found') throw new NotFoundException(e.message);
        if (e.code === 'conflict') throw new ConflictException(e.message);
        throw new BadRequestException(e.message);
      }
      throw e;
    }
  }
  @Post('clients')
  @DocumentRoute(
    'Register this browser instance for semantic UI control',
    UiBindingSchema,
    UiRegisterSchema,
    201,
  )
  register(@Body() body: unknown, @Req() req: AuthRequest) {
    const input = parse(UiRegisterSchema, body);
    return this.run(() => registerUiClient(this.infra, req.user.id, input.instanceId));
  }
  @Put('clients/:id/state')
  @DocumentRoute(
    'Publish semantic state and renew the current page lease',
    UiBindingSchema,
    UiUpdateSchema,
  )
  state(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthRequest) {
    parse(Uuid, id);
    const input = parse(UiUpdateSchema, body);
    if (input.clientId !== id) throw new BadRequestException('Client mismatch');
    return this.run(() =>
      updateUiState(this.infra, req.user.id, input, input.sessionId, input.state),
    );
  }
  @Get('clients/:id/commands')
  @DocumentRoute(
    'Discover pending UI commands for this page only',
    z.object({ items: z.array(UiCommandSchema) }),
  )
  commands(@Param('id') id: string, @Query() query: unknown, @Req() req: AuthRequest) {
    parse(Uuid, id);
    const { pageGeneration } = parse(
      z.strictObject({ pageGeneration: z.coerce.number().int().positive() }),
      query,
    );
    return this.run(async () => ({
      items: await listUiCommands(this.infra, req.user.id, { clientId: id, pageGeneration }),
    }));
  }
  @Post('commands/:id/claim')
  @DocumentRoute('Atomically claim a UI command', UiCommandSchema, UiBindingSchema, 201)
  claim(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthRequest) {
    parse(Uuid, id);
    const input = parse(UiBindingSchema, body);
    return this.run(() => claimUiCommand(this.infra, req.user.id, id, input));
  }
  @Post('commands/:id/receipts')
  @DocumentRoute(
    'Persist execution acknowledgement and verified postcondition',
    z.object({ status: z.string() }),
    UiReceiptSchema,
    201,
  )
  receipt(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthRequest) {
    parse(Uuid, id);
    const input = parse(UiReceiptSchema, body);
    return this.run(() => receiptUiCommand(this.infra, req.user.id, id, input));
  }
}
