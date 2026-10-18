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
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import type { Infrastructure } from '../../../../packages/infrastructure/clients';
import {
  CreateRouteSchema,
  UpdateRouteSchema,
  CopyRouteSchema,
  RouteOperationSchema,
  PlanRouteSchema,
  ImportRouteSchema,
  RestrictionSchema,
  CircleRouteQuerySchema,
  RouteSchema,
  RoutePlanSchema,
} from '../../../../packages/contracts/routes';
import {
  createRoute,
  updateRoute,
  listRoutes,
  getRoute,
  routeHistory,
  archiveRoute,
  copyRoute,
  exportRoute,
  importRoute,
  createRoutePlan,
  getRoutePlan,
  cancelRoutePlan,
  listRouteRestrictions,
  saveRouteRestriction,
  RouteStoreError,
} from '../../../../packages/infrastructure/routes';
import { INFRA, MinimumRole, parse, Uuid, DocumentRoute, DocumentQuery } from '../common';
import type { AuthRequest } from '../auth/guard';
const ObjectResponse = z.record(z.string(), z.unknown());
async function result<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof RouteStoreError)
      throw new HttpException({ code: error.code, message: error.code }, error.status);
    throw error;
  }
}
@Controller('routes')
export class RoutesController {
  constructor(@Inject(INFRA) private readonly infra: Infrastructure) {}
  @Get()
  @DocumentQuery(CircleRouteQuerySchema as unknown as z.ZodObject)
  @DocumentRoute(
    'List planned routes with exact geography radius filtering',
    z.object({ items: z.array(RouteSchema), total: z.number() }),
  )
  list(@Query() query: unknown) {
    return result(() => listRoutes(this.infra, parse(CircleRouteQuerySchema, query)));
  }
  @Post()
  @MinimumRole('operator')
  @DocumentRoute(
    'Save a manual route or completed planning result exactly once',
    RouteSchema,
    CreateRouteSchema,
    201,
  )
  create(@Body() body: unknown, @Req() req: AuthRequest) {
    return result(() => createRoute(this.infra, req.user, parse(CreateRouteSchema, body)));
  }
  @Post('import')
  @MinimumRole('operator')
  @DocumentRoute('Import a GeoJSON route feature', RouteSchema, ImportRouteSchema, 201)
  import(@Body() body: unknown, @Req() req: AuthRequest) {
    return result(() => importRoute(this.infra, req.user, parse(ImportRouteSchema, body)));
  }
  @Get('restrictions')
  @DocumentRoute(
    'List latest versions of restricted areas',
    z.object({ items: z.array(ObjectResponse) }),
  )
  async restrictions() {
    return { items: await listRouteRestrictions(this.infra) };
  }
  @Post('restrictions')
  @MinimumRole('operator')
  @DocumentRoute('Create a versioned restricted area', ObjectResponse, RestrictionSchema, 201)
  restrictionCreate(@Body() body: unknown, @Req() req: AuthRequest) {
    const value = parse(RestrictionSchema, body);
    return result(() => saveRouteRestriction(this.infra, req.user, value.operationId, value));
  }
  @Put('restrictions/:id')
  @MinimumRole('operator')
  @DocumentRoute(
    'Revise a restricted area with an expected revision',
    ObjectResponse,
    RestrictionSchema,
  )
  restrictionUpdate(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthRequest) {
    parse(Uuid, id);
    return result(() =>
      saveRouteRestriction(this.infra, req.user, id, parse(RestrictionSchema, body)),
    );
  }
  @Post('plans')
  @MinimumRole('operator')
  @DocumentRoute('Queue a durable sea route plan', RoutePlanSchema, PlanRouteSchema, 201)
  plan(@Body() body: unknown, @Req() req: AuthRequest) {
    return result(() => createRoutePlan(this.infra, req.user, parse(PlanRouteSchema, body)));
  }
  @Get('plans/:id')
  @DocumentRoute('Read planning state, result, source versions and staleness', RoutePlanSchema)
  async planGet(@Param('id') id: string) {
    parse(Uuid, id);
    const plan = await getRoutePlan(this.infra, id);
    if (!plan) throw new NotFoundException();
    return plan;
  }
  @Post('plans/:id/cancel')
  @MinimumRole('operator')
  @DocumentRoute(
    'Cancel a queued or running plan; late worker results are fenced',
    RoutePlanSchema,
    z.strictObject({ operationId: z.uuid() }),
  )
  cancel(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthRequest) {
    parse(Uuid, id);
    const value = parse(z.strictObject({ operationId: z.uuid() }), body);
    return result(() => cancelRoutePlan(this.infra, req.user, id, value));
  }
  @Get(':id/history')
  @DocumentRoute('Read immutable route revisions', z.object({ items: z.array(RouteSchema) }))
  async history(@Param('id') id: string) {
    parse(Uuid, id);
    return { items: await routeHistory(this.infra, id) };
  }
  @Get(':id/export')
  @DocumentRoute('Export the current route as GeoJSON', ObjectResponse)
  export(@Param('id') id: string) {
    parse(Uuid, id);
    return result(() => exportRoute(this.infra, id));
  }
  @Post(':id/archive')
  @MinimumRole('operator')
  @DocumentRoute('Archive a route with optimistic concurrency', RouteSchema, RouteOperationSchema)
  archive(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthRequest) {
    parse(Uuid, id);
    return result(() => archiveRoute(this.infra, req.user, id, parse(RouteOperationSchema, body)));
  }
  @Post(':id/copy')
  @MinimumRole('operator')
  @DocumentRoute(
    'Copy a revision into an independent draft for comparison',
    RouteSchema,
    CopyRouteSchema,
    201,
  )
  copy(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthRequest) {
    parse(Uuid, id);
    return result(() => copyRoute(this.infra, req.user, id, parse(CopyRouteSchema, body)));
  }
  @Get(':id')
  @DocumentRoute('Read the current route revision', RouteSchema)
  async get(@Param('id') id: string) {
    parse(Uuid, id);
    const value = await getRoute(this.infra, id);
    if (!value) throw new NotFoundException();
    return value;
  }
  @Put(':id')
  @MinimumRole('operator')
  @DocumentRoute(
    'Update a route using an expected revision and operation id',
    RouteSchema,
    UpdateRouteSchema,
  )
  update(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthRequest) {
    parse(Uuid, id);
    return result(() => updateRoute(this.infra, req.user, id, parse(UpdateRouteSchema, body)));
  }
}
