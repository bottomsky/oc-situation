import { AgentQueryResultSchema } from '../../../../packages/contracts/agent';
import { AgentHeatmapResultSchema } from '../../../../packages/contracts/heatmap';
import { AgentVesselTracksResultSchema } from '../../../../packages/contracts/vessel-tracks';
import { z } from 'zod';
import {
  RouteSchema,
  RoutePlanSchema,
  OperationalEventSchema,
  AgentFocusResultSchema,
} from '@ais/contracts';

const revision = { inputRevision: z.number().int().nonnegative().optional() };
const RouteArtifactSchema = z.union([
  z.strictObject({ kind: z.literal('route'), route: RouteSchema, ...revision }).transform((v) => ({
    kind: v.kind,
    routes: [v.route],
    total: 1,
    truncated: false,
    inputRevision: v.inputRevision,
  })),
  z
    .strictObject({
      kind: z.literal('route'),
      routes: z.array(RouteSchema).max(100),
      total: z.number().int().nonnegative(),
      truncated: z.boolean(),
      ...revision,
    })
    .refine((v) => v.total >= v.routes.length && v.truncated === v.total > v.routes.length),
]);
const PlanArtifactSchema = z.strictObject({
  kind: z.literal('route_plan'),
  plan: RoutePlanSchema,
  ...revision,
});
const EventArtifactSchema = z.strictObject({
  kind: z.literal('operational_event'),
  event: OperationalEventSchema,
  ...revision,
});
const EventsArtifactSchema = z
  .strictObject({
    kind: z.literal('operational_events'),
    items: z.array(OperationalEventSchema).max(100),
    total: z.number().int().nonnegative(),
    ...revision,
  })
  .refine((v) => v.total >= v.items.length)
  .transform((v) => ({ ...v, truncated: v.total > v.items.length }));

interface ArtifactInput {
  id: string;
  stepId: string;
  kind: string;
  inputRevision: number;
  payload: unknown;
}
export function readSkillArtifacts(artifacts: ArtifactInput[], inputRevision: number) {
  return artifacts
    .filter((artifact) => artifact.inputRevision === inputRevision)
    .map((artifact) => {
      const schema =
        artifact.kind === 'ais_heatmap'
          ? AgentHeatmapResultSchema
          : artifact.kind === 'vessel_tracks'
            ? AgentVesselTracksResultSchema
            : artifact.kind === 'vessel_list' || artifact.kind === 'vessel_detail'
              ? AgentQueryResultSchema
              : artifact.kind === 'route'
                ? RouteArtifactSchema
                : artifact.kind === 'route_plan'
                  ? PlanArtifactSchema
                  : artifact.kind === 'operational_event'
                    ? EventArtifactSchema
                    : artifact.kind === 'operational_events'
                      ? EventsArtifactSchema
                      : artifact.kind === 'map_focus'
                        ? AgentFocusResultSchema
                        : null;
      const parsed = schema?.safeParse(artifact.payload);
      const result =
        parsed?.success &&
        parsed.data.kind === artifact.kind &&
        (parsed.data.inputRevision === undefined || parsed.data.inputRevision === inputRevision)
          ? parsed.data
          : null;
      return { ...artifact, result };
    });
}
