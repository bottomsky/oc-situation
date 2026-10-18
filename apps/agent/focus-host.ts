import type { Infrastructure } from '../../packages/infrastructure/clients';
import { projectCircleRegion } from '../../packages/infrastructure/agent-focus';
import { getRoute, getRoutePlan } from '../../packages/infrastructure/routes';
import { getOperationalEvent } from '../../packages/infrastructure/operational-event-store';
import { plotIntelligence } from '../../packages/infrastructure/intelligence-store';
import { queryAgentVessels } from '../../packages/infrastructure/agent-query';
import { AgentVesselTracksResultSchema } from '../../packages/contracts/vessel-tracks';
import { RouteSchema } from '../../packages/contracts/routes';
import { OperationalEventSchema } from '../../packages/contracts/operational-events';
import { bboxFocusGeometry } from '../../packages/domain/agent-focus';
import type { FocusTargetRef, FocusTargetSnapshot } from '../../packages/contracts/agent-focus';
import type { RuntimeContext } from './runtime';

export function createFocusResolver(infra: Infrastructure, signal?: AbortSignal) {
  return async (
    ref: FocusTargetRef,
    context: RuntimeContext,
  ): Promise<FocusTargetSnapshot | FocusTargetSnapshot[] | null> => {
    if (signal?.aborted) throw new Error('cancelled');
    if (ref.kind === 'route') {
      if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(ref.id)) return null;
      const route =
        ref.revision === undefined
          ? await getRoute(infra, ref.id)
          : RouteSchema.safeParse(
              (
                await infra.pool.query(
                  'SELECT document FROM route_revisions WHERE route_id=$1 AND revision=$2',
                  [ref.id, ref.revision],
                )
              ).rows[0]?.document,
            ).data;
      if (!route) {
        if (ref.revision !== undefined) return null;
        const owned = await infra.pool.query(
          'SELECT id FROM route_plans WHERE id=$1 AND user_id=$2',
          [ref.id, context.task.ownerId],
        );
        const plan = owned.rowCount ? await getRoutePlan(infra, ref.id) : null;
        return plan?.status === 'completed' && plan.result
          ? {
              ref,
              label: '本轮规划航线',
              geometry: plan.result.geometry,
              source: 'completed-route-plan',
            }
          : null;
      }
      return {
        ref: { ...ref, revision: route.revision },
        label: route.name,
        geometry: route.geometry,
        source: 'routes',
      };
    }
    if (ref.kind === 'event') {
      if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(ref.id)) return null;
      // Explicit revisions address the original event even after it has been merged.
      const event =
        ref.revision === undefined
          ? await getOperationalEvent(infra, ref.id)
          : OperationalEventSchema.safeParse(
              (
                await infra.pool.query(
                  'SELECT data FROM operational_event_revisions WHERE event_id=$1 AND revision=$2',
                  [ref.id, ref.revision],
                )
              ).rows[0]?.data,
            ).data;
      if (!event?.geometry) return null;
      return {
        ref: { ...ref, revision: event.revision },
        label: event.title,
        geometry: event.geometry,
        source: 'operational-events',
      };
    }
    if (ref.kind === 'intelligence') {
      const evidence =
        context.intelligenceResult?.inputRevision === (context.task.inputRevision ?? 0)
          ? context.intelligenceResult.evidence.find(
              (item) => item.kind === 'event' && item.event.id === ref.id,
            )
          : undefined;
      if (
        evidence?.kind === 'event' &&
        (ref.revision === undefined || ref.revision === evidence.event.version)
      ) {
        return evidence.event.geometry
          ? {
              ref: { ...ref, revision: evidence.event.version },
              label: evidence.event.title,
              geometry: evidence.event.geometry,
              source: 'intelligence-query-snapshot',
            }
          : null;
      }
      if (ref.revision !== undefined) {
        const version = await infra.pool.query(
          'SELECT id FROM intelligence_events WHERE id=$1 AND version=$2',
          [ref.id, ref.revision],
        );
        if (!version.rowCount) return null;
      }
      const result = await plotIntelligence(infra, [ref.id], false);
      // Multiple evidence features remain complete by converting only homogeneous primitive geometries.
      const features = result.features;
      if (!features.length) return null;
      if (features.length === 1)
        return {
          ref,
          label: result.items[0]?.title ?? ref.id,
          geometry: features[0]!.geometry,
          source: 'intelligence-relations',
        };
      const polygons = features.flatMap((f) =>
        f.geometry.type === 'Polygon'
          ? [f.geometry.coordinates]
          : f.geometry.type === 'MultiPolygon'
            ? f.geometry.coordinates
            : [],
      );
      const lines = features.flatMap((f) =>
        f.geometry.type === 'LineString'
          ? [f.geometry.coordinates]
          : f.geometry.type === 'MultiLineString'
            ? f.geometry.coordinates
            : [],
      );
      const points = features.flatMap((f) =>
        f.geometry.type === 'Point'
          ? [f.geometry.coordinates]
          : f.geometry.type === 'MultiPoint'
            ? f.geometry.coordinates
            : [],
      );
      if (polygons.length && !lines.length && !points.length)
        return {
          ref,
          label: result.items[0]?.title ?? ref.id,
          geometry: { type: 'MultiPolygon', coordinates: polygons },
          source: 'intelligence-relations',
        };
      if (lines.length && !polygons.length && !points.length)
        return {
          ref,
          label: result.items[0]?.title ?? ref.id,
          geometry: { type: 'MultiLineString', coordinates: lines },
          source: 'intelligence-relations',
        };
      if (points.length && !polygons.length && !lines.length)
        return {
          ref,
          label: result.items[0]?.title ?? ref.id,
          geometry: { type: 'MultiPoint', coordinates: points },
          source: 'intelligence-relations',
        };
      return features.map((feature) => ({
        ref,
        label: result.items[0]?.title ?? ref.id,
        geometry: feature.geometry,
        source: `intelligence-relation:${feature.id}`,
      }));
    }
    if (ref.kind === 'region') {
      const region = context.task.selection?.region;
      if (!region) return null;
      const geometry =
        region.kind === 'circle'
          ? await projectCircleRegion(infra, region)
          : region.kind === 'polygon'
            ? region.geometry
            : bboxFocusGeometry(region.bbox);
      return { ref, label: '本轮区域', geometry, region, source: 'task-selection' };
    }
    if (ref.kind === 'vessel' && /^[1-9]\d{8}$/.test(ref.id)) {
      const result = await queryAgentVessels(
        infra,
        {
          kind: 'vessel_detail',
          inputRevision: context.task.inputRevision ?? 0,
          selection: { mmsis: [ref.id], filters: { hours: 720 } },
        },
        { signal },
      );
      const vessel = result.items[0],
        p = vessel?.latestPosition;
      if (p)
        return {
          ref,
          label: vessel.name ?? ref.id,
          geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
          observedAt: p.observedAt,
          source: p.sourceId,
        };
    }
    if (ref.kind === 'track' && /^[1-9]\d{8}$/.test(ref.id)) {
      if (!ref.sourceTaskId || ref.revision === undefined) return null;
      const row = (
        await infra.pool.query(
          "SELECT r.tracks_result FROM agent_results r JOIN agent_tasks t ON t.id=r.task_id WHERE t.owner_id=$1 AND t.session_id=$2 AND r.task_id=$3 AND r.version=$4 AND r.tracks_result->'tracks' @> $5::jsonb",
          [
            context.task.ownerId,
            context.task.sessionId,
            ref.sourceTaskId,
            ref.revision,
            JSON.stringify([{ mmsi: ref.id }]),
          ],
        )
      ).rows[0];
      const result = AgentVesselTracksResultSchema.safeParse(row?.tracks_result).data;
      const track = result?.tracks.find((t) => t.mmsi === ref.id);
      if (track?.segments.length) {
        const coordinates = track.segments
          .map((s) => s.points.map((p): [number, number] => [p.lon, p.lat]))
          .map((line) => (line.length === 1 ? [line[0]!, line[0]!] : line));
        return {
          ref,
          label: track.name ?? ref.id,
          geometry: { type: 'MultiLineString', coordinates },
          source: 'persisted-session-track-result',
        };
      }
    }
    return null;
  };
}
