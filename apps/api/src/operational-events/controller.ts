import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import type { Infrastructure } from '@ais/infrastructure';
import {
  OperationalEventSchema,
  CreateOperationalEventSchema,
  UpdateOperationalEventSchema,
  MergeOperationalEventsSchema,
  OperationalEventQuerySchema,
} from '../../../../packages/contracts/operational-events';
import {
  createOperationalEvent,
  updateOperationalEvent,
  mergeOperationalEvents,
  listOperationalEvents,
  getOperationalEvent,
  getOperationalEventHistory,
  getOperationalEventSources,
  getOperationalEventSourceHistory,
  OperationalEventError,
} from '../../../../packages/infrastructure/operational-event-store';
import {
  backfillOperationalEventSources,
  processOperationalEventSync,
} from '../../../../packages/infrastructure/operational-event-sync';
import { DocumentQuery, DocumentRoute, INFRA, MinimumRole, Uuid, parse } from '../common';
import type { AuthRequest } from '../auth/guard';

async function translate<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof OperationalEventError)
      throw new HttpException(error.message, error.status);
    throw error;
  }
}
@Controller('operational-events')
export class OperationalEventsController {
  constructor(@Inject(INFRA) private readonly infra: Infrastructure) {}
  @Get()
  @DocumentQuery(
    OperationalEventQuerySchema.omit({ circle: true }).extend({ circle: z.string().optional() }),
  )
  @DocumentRoute(
    'List independent operational events with exact radius filtering',
    z.object({ items: z.array(OperationalEventSchema), total: z.number() }),
  )
  list(@Query() query: Record<string, unknown>) {
    let circle = query.circle;
    if (typeof circle === 'string') {
      try {
        circle = JSON.parse(circle);
      } catch {
        circle = null;
      }
    }
    return listOperationalEvents(
      this.infra,
      parse(OperationalEventQuerySchema, { ...query, ...(circle === undefined ? {} : { circle }) }),
    );
  }
  @Post()
  @MinimumRole('operator')
  @DocumentRoute(
    'Create an operational event with transactional idempotency',
    OperationalEventSchema,
    CreateOperationalEventSchema,
    201,
  )
  create(@Body() body: unknown, @Req() req: AuthRequest) {
    return translate(
      createOperationalEvent(this.infra, parse(CreateOperationalEventSchema, body), req.user),
    );
  }
  @Post('backfill')
  @MinimumRole('admin')
  @DocumentRoute(
    'Reconcile existing intelligence and analysis sources',
    z.object({ intelligence: z.number(), analysis: z.number(), applied: z.number() }),
  )
  async backfill() {
    const result = await backfillOperationalEventSources(this.infra);
    return { ...result, applied: await processOperationalEventSync(this.infra) };
  }
  @Get(':id')
  @DocumentRoute('Read an event, resolving an earlier merged id', OperationalEventSchema)
  async detail(@Param('id') id: string) {
    const value = await getOperationalEvent(this.infra, parse(Uuid, id));
    if (!value) throw new NotFoundException('Event not found');
    return value;
  }
  @Patch(':id')
  @MinimumRole('operator')
  @DocumentRoute(
    'Revise fields, release source overrides or change lifecycle',
    OperationalEventSchema,
    UpdateOperationalEventSchema,
  )
  update(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthRequest) {
    return translate(
      updateOperationalEvent(
        this.infra,
        parse(Uuid, id),
        parse(UpdateOperationalEventSchema, body),
        req.user,
      ),
    );
  }
  @Post(':id/merge')
  @MinimumRole('operator')
  @DocumentRoute(
    'Merge events with an explicit primary source and both revision checks',
    OperationalEventSchema,
    MergeOperationalEventsSchema,
    201,
  )
  merge(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthRequest) {
    return translate(
      mergeOperationalEvents(
        this.infra,
        parse(Uuid, id),
        parse(MergeOperationalEventsSchema, body),
        req.user,
      ),
    );
  }
  @Get(':id/history')
  @DocumentRoute(
    'Immutable business event revisions',
    z.object({ items: z.array(OperationalEventSchema) }),
  )
  async history(@Param('id') id: string) {
    return { items: await getOperationalEventHistory(this.infra, parse(Uuid, id)) };
  }
  @Get(':id/sources')
  @DocumentRoute(
    'Current source evidence, including independent review and withdrawal status',
    z.object({ items: z.array(z.record(z.string(), z.unknown())) }),
  )
  async sources(@Param('id') id: string) {
    return { items: await getOperationalEventSources(this.infra, parse(Uuid, id)) };
  }
  @Get(':id/source-history')
  @DocumentQuery(z.object({ key: z.string().min(1) }))
  @DocumentRoute(
    'Immutable revisions of one attached source',
    z.object({ items: z.array(z.record(z.string(), z.unknown())) }),
  )
  async sourceHistory(@Param('id') id: string, @Query('key') key: string) {
    const sources = await getOperationalEventSources(this.infra, parse(Uuid, id));
    if (!sources.some((source) => source.key === key))
      throw new NotFoundException('Source not attached to event');
    return { items: await getOperationalEventSourceHistory(this.infra, key) };
  }
}
