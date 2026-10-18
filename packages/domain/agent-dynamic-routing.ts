import { parseCircleRegion } from './agent-focus';
import { parseBusinessRequest } from './agent-business';
import type { AgentIntent, AgentSelection, AgentPurpose } from '../contracts/agent';
import { deriveAgentIntent } from './agent-intents';
import { heatmapSelection } from './heatmap-intent';

export interface DynamicRoutingOptions {
  enabled: boolean;
  intent?: AgentIntent;
  skillRef?: { skillId: string; version?: string };
}
export function dynamicTaskSelection(
  goal: string,
  selection: AgentSelection,
  now: Date,
): AgentSelection {
  const output = { ...selection };
  const circle = parseCircleRegion(goal);
  if (circle) {
    output.region = circle;
    delete output.bbox;
  }
  if (!output.timeRange || /最近|过去|昨天|今天|小时|天|时间|时段|\d{4}-\d{2}-\d{2}/.test(goal)) {
    const temporal = heatmapSelection(goal, now);
    if (temporal.heatmapTimeUnclear) {
      delete output.timeRange;
      output.heatmapTimeUnclear = true;
      output.tracksTimeUnclear = true;
    } else if (temporal.timeRange) {
      output.timeRange = temporal.timeRange;
      delete output.heatmapTimeUnclear;
      delete output.tracksTimeUnclear;
    }
  }
  const mmsis = [
    ...new Set([...goal.matchAll(/(?<!\d)([1-9]\d{8})(?!\d)/g)].map((match) => match[1]!)),
  ];
  const selector = { ...output.vesselSelector };
  const types = new Set<number>();
  for (const [pattern, first, last] of [
    ['货船', 70, 79],
    ['油轮|油船', 80, 89],
    ['客船', 60, 69],
    ['渔船', 30, 30],
  ] as const) {
    if (new RegExp(pattern).test(goal))
      for (let index = first; index <= last; index++) types.add(index);
  }
  const codes = [...goal.matchAll(/船型(?:编码|代码)?(?:为)?\s*[:：]?\s*(\d{1,2})(?!\d)/g)].map(
    (match) => Number(match[1]),
  );
  if (codes.length)
    selector.shipTypes = [...new Set(codes)].filter((code) => code > 0 && code < 100);
  else if (types.size) selector.shipTypes = [...types];
  if (mmsis.length) {
    output.mmsis = mmsis;
    selector.mmsis = mmsis;
  }
  const model =
    goal.match(/(?:型号|船舶型号)(?:为)?\s*[:：]?\s*[“「"']?([A-Za-z0-9][A-Za-z0-9-]{1,30})/) ??
    goal.match(/([A-Za-z0-9][A-Za-z0-9-]{1,30})型(?:船舶|舰艇|船|舰)/);
  if (model) selector.model = model[1];
  const name =
    goal.match(/(?:船名|名称|呼号)\s*[:：]?\s*[“「"']([^”」"']{1,200})[”」"']/) ??
    goal.match(
      /(?:船名|名称|呼号)\s*[:：]?\s*([^\s，,。；;“”「」"']{1,100}?)(?=的?(?:船舶|历史|航线|轨迹)|并|再|和|\s|[，,。；;]|$)/,
    );
  if (name) selector.query = name[1];
  const imo = goal.match(/IMO\s*[:：]?\s*(\d{7})(?!\d)/i);
  if (imo && !name) selector.query = imo[1];
  if (Object.keys(selector).length) output.vesselSelector = selector;
  return output;
}

export function hasUnresolvedDynamicSelector(goal: string, selection: AgentSelection): boolean {
  const selector = selection.vesselSelector;
  return (
    (/型号|[A-Za-z0-9-]{2,}型(?:船舶|船|舰)/.test(goal) && !selector?.model) ||
    (/船名|名称|呼号|IMO/i.test(goal) && !selector?.query) ||
    (/MMSI/i.test(goal) && !selector?.mmsis?.length && !selection.mmsis?.length)
  );
}

/** Finite semantic extraction keeps user prose and all identifiers inside the platform. */
export interface DynamicGoalProjection {
  operations: string[];
  vesselClass?: 'cargo' | 'tanker' | 'passenger' | 'fishing';
  vesselClasses: ('cargo' | 'tanker' | 'passenger' | 'fishing')[];
  presentation: boolean;
  purpose?: AgentPurpose;
  inputRefs: string[];
  goalKind: 'compose' | 'resolve';
}
export function dynamicGoalProjection(goal: string, purpose?: AgentPurpose): DynamicGoalProjection {
  const operations: string[] = [];
  const business = parseBusinessRequest(goal);
  if (business)
    return {
      operations: [business.toolId],
      vesselClasses: [],
      presentation: false,
      inputRefs: ['input.selection'],
      goalKind: 'resolve',
    };
  const chartRequest = /航线|历史轨迹|船舶轨迹|vessel.?tracks|热力图|热度图|密度图|heatmap/i.test(
    goal,
  );
  if (
    /筛选|找出|列出|船舶列表|哪些船|多少船|(?:查询|查看).{0,12}(?:船舶|货船|油轮).{0,4}(?:并|再|然后)/.test(
      goal,
    ) ||
    (!chartRequest && /(?:查询|查看).{0,12}(?:船舶|货船|油轮|列表)|当前区域货船/.test(goal))
  )
    operations.push('query_vessels');
  if (/航线|历史轨迹|船舶轨迹|vessel.?tracks/i.test(goal)) operations.push('query_vessel_tracks');
  if (/热力图|热度图|密度图|heatmap/i.test(goal)) operations.push('query_ais_heatmap');
  if (/情报|公告|新闻|海况|预报/.test(goal)) operations.push('search_intelligence');
  if (/高亮|水波(?:提醒|扩散)/.test(goal)) operations.push('prepare_vessel_highlights');
  if (/聚焦|镜头|(?:海图|地图).*(?:缩放|放大|缩小)/.test(goal))
    operations.push('prepare_map_camera');
  const requestedCount = operations.length;
  const vesselClasses: DynamicGoalProjection['vesselClasses'] = [];
  for (const [pattern, vesselClass] of [
    ['货船', 'cargo'],
    ['油轮|油船', 'tanker'],
    ['客船', 'passenger'],
    ['渔船', 'fishing'],
  ] as const)
    if (new RegExp(pattern).test(goal)) vesselClasses.push(vesselClass);
  const scopedVesselSet =
    vesselClasses.length > 0 || /型号|船名|名称|呼号|MMSI|IMO|船型/i.test(goal);
  const prerequisites: Readonly<Record<string, readonly string[]>> = scopedVesselSet
    ? {
        query_vessel_tracks: ['query_vessels'],
        query_ais_heatmap: ['query_vessels'],
      }
    : {};
  for (const operation of [...operations])
    for (const dependency of prerequisites[operation] ?? [])
      if (!operations.includes(dependency)) operations.unshift(dependency);
  const selected: Partial<Record<AgentPurpose, string>> = {
    vessel_list: 'query_vessels',
    vessel_detail: 'query_vessels',
    vessel_tracks: 'query_vessel_tracks',
    ais_heatmap: 'query_ais_heatmap',
    intelligence_search: 'search_intelligence',
  };
  const selectedOperation = purpose ? selected[purpose] : undefined;
  const answeredPurpose = !operations.length && selectedOperation;
  if (answeredPurpose) operations.push(answeredPurpose);
  return {
    operations,
    vesselClasses,
    ...(vesselClasses.length === 1 ? { vesselClass: vesselClasses[0] } : {}),
    presentation:
      /展示|显示|绘制|画出|海图|同时看|高亮|聚焦|镜头/.test(goal) ||
      (!!answeredPurpose && ['vessel_tracks', 'ais_heatmap'].includes(purpose ?? '')),
    ...(answeredPurpose ? { purpose } : {}),
    inputRefs: ['input.selection'],
    goalKind: requestedCount > 1 ? ('compose' as const) : ('resolve' as const),
  };
}

export function shouldUseDynamicSkill(goal: string, options: DynamicRoutingOptions): boolean {
  if (!options.enabled) return false;
  if (options.skillRef || options.intent === 'skill') return true;
  if (
    /^(?:已确认区域(?:请执行)?|确认区域|已选择区域请执行|请执行|开始|继续(?:分析)?)$/.test(
      goal.replace(/[，,。！!\s]/g, ''),
    )
  )
    return false;
  const derived = deriveAgentIntent(goal).intent;
  if (
    !/不要|不必|无需|不用|别再/.test(goal) &&
    /(?:创建|生成|保存|编写).*(?:skill|技能)/i.test(goal)
  )
    return true;
  if (
    (derived === 'vessel_highlights' || derived === 'map_camera') &&
    !/航线|轨迹|热力图|热度图|情报|公告|新闻|海况|预报/.test(goal)
  )
    return false;
  if (derived === 'conversation' || derived === 'explain') return false;
  // Closing existing windows remains a UI task, even if two chart names are present.
  if (derived === 'ui_control' && /关闭|隐藏|收起/.test(goal)) return false;
  if (/不要|不必|无需|不用|别再/.test(goal)) return false;
  if (dynamicGoalProjection(goal).goalKind === 'compose') return true;
  return derived === 'unresolved';
}
