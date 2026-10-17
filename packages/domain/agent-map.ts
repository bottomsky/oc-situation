import type { AgentQueryResult, AgentSelection } from '../contracts/agent';
import { z } from 'zod';
import {
  AgentVesselHighlightsResultSchema,
  MapCameraRequestSchema,
  type MapCameraRequest,
} from '../contracts/agent-map';
import { dynamicTaskSelection } from './agent-dynamic-routing';

export function mapTaskSelection(goal: string, selection: AgentSelection): AgentSelection {
  const output = dynamicTaskSelection(goal, selection, new Date());
  if (
    !output.vesselSelector &&
    !/经度|纬度|坐标|点位|区域|视野|缩放|清除|取消|关闭|停止|\bzoom\b/i.test(goal)
  ) {
    const named =
      goal.match(
        /(?:高亮|聚焦|定位)(?:显示)?\s*(?:船舶|船只)?\s*[“「"']([^”」"']{1,200})[”」"']/,
      ) ??
      goal.match(
        /(?:高亮|聚焦|定位)\s*(?:船舶|船只)\s+([A-Za-z][A-Za-z0-9 ._-]{1,100}?)(?=\s*(?:并|然后|$))/,
      );
    if (named) output.vesselSelector = { query: named[1]!.trim() };
  }
  output.highlightAndFocus = /高亮/.test(goal) && /聚焦|镜头|定位|放大/.test(goal);
  if (/高亮/.test(goal) && /清除|取消|关闭|停止/.test(goal)) {
    const groups = [
      ...goal.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi),
    ].map((m) => m[0]);
    const taskIndex = goal.match(/任务\s*(\d+)/);
    if (groups.length) output.highlightClear = { mode: 'groups', groupIds: [...new Set(groups)] };
    else if (taskIndex) output.highlightTaskIndex = Number(taskIndex[1]);
    else if (
      /全部|所有/.test(goal) ||
      /^(?:请|帮我|请帮我)?(?:清除|取消|关闭|停止)(?:船舶)?高亮(?:效果|提醒)?[。！!]?\s*$/.test(
        goal.trim(),
      )
    )
      output.highlightClear = { mode: 'all' };
    else output.highlightClearUnclear = true;
  }
  const zoom = goal.match(
    /(?:缩放(?:级别|等级)?|zoom)\s*(?:到|至|为|设为|[:：])?\s*(\d+(?:\.\d+)?)/i,
  );
  const delta = goal.match(/(?:放大|缩小)\s*(\d+(?:\.\d+)?)\s*(?:级|倍)?/);
  const relative = delta
    ? Number(delta[1]) * (/缩小/.test(delta[0]) ? -1 : 1)
    : /放大|缩小/.test(goal) && /镜头|海图|地图|聚焦/.test(goal)
      ? /缩小/.test(goal)
        ? -1
        : 1
      : undefined;
  if (zoom && relative !== undefined) throw new Error('invalid_camera_zoom');
  const targetZoom = zoom
    ? z.number().min(0).max(22).parse(Number(zoom[1]))
    : relative !== undefined
      ? Math.min(22, Math.max(0, 10 + z.number().min(-22).max(22).parse(relative)))
      : 10;
  const lon = goal.match(/(?:经度|lon(?:gitude)?)\s*[:：]?\s*(-?\d+(?:\.\d+)?)/i);
  const lat = goal.match(/(?:纬度|lat(?:itude)?)\s*[:：]?\s*(-?\d+(?:\.\d+)?)/i);
  const pair = goal.match(
    /(?:坐标|点位)\s*[:：]?\s*[（(]?\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)/,
  );
  const center =
    lon && lat
      ? [Number(lon[1]), Number(lat[1])]
      : pair
        ? [Number(pair[1]), Number(pair[2])]
        : undefined;
  if ((lon && !lat) || (!lon && lat)) throw new Error('invalid_camera_point');
  if (center)
    output.mapCamera = MapCameraRequestSchema.parse({ mode: 'point', center, zoom: targetZoom });
  else if (
    /聚焦|镜头|海图/.test(goal) &&
    /区域|视野/.test(goal) &&
    output.bbox &&
    !output.vesselSelector &&
    !output.mmsis?.length
  )
    output.mapCamera = MapCameraRequestSchema.parse({
      mode: 'bounds',
      bbox: output.bbox,
      maxZoom: targetZoom,
    });
  else if ((zoom || relative !== undefined) && (output.vesselSelector || output.mmsis?.length))
    output.mapTargetZoom = targetZoom;
  else if (zoom || relative !== undefined)
    output.mapCamera = MapCameraRequestSchema.parse({
      mode: 'current',
      ...(zoom ? { zoom: targetZoom } : { zoomDelta: relative }),
    });
  return output;
}

export function highlightsFromVessels(result: AgentQueryResult, revision: number) {
  if (result.truncated || result.total > 100) throw new Error('data_limit');
  const missing = result.items.filter((v) => !v.latestPosition).map((v) => v.mmsi);
  const missingRequested = (
    result.selection.mmsis ??
    result.selection.vesselSelector?.mmsis ??
    []
  ).filter((mmsi) => !result.items.some((v) => v.mmsi === mmsi));
  const vessels = result.items.flatMap((v) =>
    v.latestPosition ? [{ mmsi: v.mmsi, name: v.name, ...v.latestPosition }] : [],
  );
  if (!vessels.length) throw new Error('no_positions');
  // Query metadata stays in the host; the browser receives only validated display positions.
  return AgentVesselHighlightsResultSchema.parse({
    kind: 'vessel_highlights',
    version: 0,
    inputRevision: revision,
    operation: 'show',
    vessels: vessels.map(({ mmsi, name, lon, lat, observedAt }) => ({
      mmsi,
      name,
      lon,
      lat,
      observedAt,
    })),
    missingMmsis: [...new Set([...missing, ...missingRequested])],
  });
}

export function cameraFromVessels(result: AgentQueryResult): MapCameraRequest {
  if (result.truncated || result.total > 100) throw new Error('data_limit');
  const points = result.items.flatMap((v) => (v.latestPosition ? [v.latestPosition] : []));
  if (!points.length) throw new Error('no_positions');
  if (points.length === 1)
    return { mode: 'point', center: [points[0]!.lon, points[0]!.lat], zoom: 10 };
  const lons = points.map((p) => p.lon).sort((a, b) => a - b);
  let gap = -1,
    start = 0;
  for (let i = 0; i < lons.length; i++) {
    const distance = lons[(i + 1) % lons.length]! + (i === lons.length - 1 ? 360 : 0) - lons[i]!;
    if (distance > gap) {
      gap = distance;
      start = (i + 1) % lons.length;
    }
  }
  return {
    mode: 'bounds',
    bbox: [
      lons[start]!,
      Math.min(...points.map((p) => p.lat)),
      lons[(start + lons.length - 1) % lons.length]!,
      Math.max(...points.map((p) => p.lat)),
    ],
    maxZoom: 10,
  };
}
