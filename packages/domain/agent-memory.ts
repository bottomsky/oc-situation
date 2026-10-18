import type { AgentIntent, AgentMapContext, AgentSelection } from '../contracts/agent';
import { AgentSelectionSchema } from '../contracts/agent';
import type { AgentMemoryObjectSet } from '../contracts/agent-memory';
import type { AgentAccountMemoryEntry } from '../contracts/agent-memory';
import { heatmapSelection } from './heatmap-intent';

export interface ReferentMemory {
  objectSets: AgentMemoryObjectSet[];
  conditions: Record<string, unknown>;
}
export type MemoryInstruction =
  | { action: 'forget_session_objects' }
  | { action: 'confirm' }
  | { action: 'remember' | 'update' | 'forget'; content: string };

export function preferenceKey(content: string): string {
  if (/回答|回复|简短|详细|简洁|语言|中文|英文/.test(content)) return '回答方式';
  if (/过去|最近|小时|时间|默认.*轨迹/.test(content)) return '历史查询默认';
  if (/船|MMSI|型号|关注/.test(content)) return '关注偏好';
  return content.slice(0, 80);
}
export const isMemoryRecall = (goal: string) =>
  /^(?:请)?(?:我(?:刚才|之前|上次)(?:说|问|提到)(?:了)?什么|(?:我的|你记住的)(?:偏好|习惯|记忆)(?:是|有)?什么)[？?。!！]*$/.test(
    goal.trim(),
  );
export const hasExplicitTime = (goal: string) =>
  /最近|过去|昨天|今天|小时|分钟|\d+天|\d{4}[-/]|北京时间|UTC/.test(goal);

export function applyAccountMemoryDefaults(
  goal: string,
  selection: AgentSelection,
  entries: AgentAccountMemoryEntry[],
  now: Date,
): AgentSelection {
  if (hasExplicitTime(goal)) return selection;
  const values = entries
    .filter(
      (entry) =>
        entry.status === 'active' &&
        entry.key === '历史查询默认' &&
        typeof entry.value === 'string',
    )
    .map((entry) => String(entry.value));
  const ranges = values
    .map((value) =>
      heatmapSelection(value.replace(/以后|默认|我习惯|我喜欢|我通常|我平时/g, ''), now),
    )
    .filter((parsed) => parsed.timeRange && !parsed.heatmapTimeUnclear);
  if (ranges.length !== 1) return selection;
  return {
    ...selection,
    timeRange: ranges[0]!.timeRange,
    tracksTimeUnclear: false,
    heatmapTimeUnclear: false,
  };
}

/** Only the current user's explicit wording authorizes a durable preference mutation. */
export function parseMemoryInstruction(goal: string): MemoryInstruction | null {
  const text = goal.trim().replace(/[。！!]+$/, '');
  if (
    /^(?:请)?(?:忘掉|忘记|清除)(?:刚才|刚刚|上次|之前|这|那)(?:的)?(?:这|那)?(?:一)?批(?:船|船舶|对象|目标)?$/.test(
      text,
    )
  )
    return { action: 'forget_session_objects' };
  if (/^(?:确认|同意|可以)(?:保存|记住)(?:这个|该|刚才的)?偏好$/.test(text))
    return { action: 'confirm' };
  const update = text.match(
    /^(?:请)?(?:把|将)?(?:我的)?(?:偏好|习惯|记忆)(?:修改|更改|改|更新)(?:为|成|到)[：:\s]*(.+)$/,
  );
  if (update) return { action: 'update', content: update[1]!.trim() };
  const forget = text.match(
    /^(?:请)?(?:忘记|忘掉|删除|清除)(?:我的)?(?:偏好|习惯|记忆)[：:\s]*(.+)$/,
  );
  if (forget) return { action: 'forget', content: forget[1]!.trim() };
  const remember = text.match(/^(?:请)?(?:帮我)?(?:记住|记下来|保存我的偏好)[：:\s]*(.+)$/);
  if (remember) return { action: 'remember', content: remember[1]!.trim() };
  return null;
}

const referential =
  /刚才|刚刚|上次|上面|上述|前面|这批|那批|这些|那些|它们|它|该船|这艘|继续|再查|再统计/;
const bareTargetAction =
  /^(?:请|帮我|请帮我)?(?:聚焦|定位|关注|高亮)(?:一下|它们|这些|这批|刚才这批)?[。！!\s]*$/;
export const isMemoryContinuation = (goal: string) =>
  referential.test(goal) || /改成|改为|换成|还是/.test(goal);

export function deriveMemoryIntent(
  goal: string,
  derived: { intent: AgentIntent; purpose?: AgentSelection['purpose'] },
  memory: ReferentMemory | null,
): typeof derived {
  if (isMemoryRecall(goal)) return { intent: 'conversation' };
  if (memory && /^(?:继续|再)(?:解释|说明|总结)|^(?:为什么|为何)[？?。!！\s]*$/.test(goal.trim()))
    return { intent: 'explain' };
  if (derived.intent !== 'unresolved' || !memory) return derived;
  if (/统计|数量|多少/.test(goal) && referential.test(goal))
    return { intent: 'vessel_list', purpose: 'vessel_list' };
  if (isMemoryContinuation(goal)) {
    const lastIntent = memory.conditions.intent;
    if (
      [
        'vessel_list',
        'vessel_detail',
        'analysis',
        'vessel_tracks',
        'ais_heatmap',
        'intelligence_search',
      ].includes(String(lastIntent))
    ) {
      const previous = AgentSelectionSchema.safeParse(memory.conditions.selection).data;
      return {
        intent: lastIntent as AgentIntent,
        ...(previous?.purpose ? { purpose: previous.purpose } : {}),
      };
    }
  }
  return derived;
}

/** Resolve local object identity before validation; the account memory never participates. */
export function resolveMemorySelection(
  goal: string,
  selection: AgentSelection,
  intent: AgentIntent,
  memory: ReferentMemory | null,
  submitted?: Pick<AgentMapContext, 'selectedMmsis' | 'selectedTargets'>,
  options: { explicitScope?: boolean } = {},
): { selection: AgentSelection; ambiguous: boolean; tooMany?: boolean; source?: string } {
  let output = structuredClone(selection);
  if (output.vesselCircle) return { selection: output, ambiguous: false };
  const clear = output.highlightClear || output.highlightTaskIndex || output.highlightClearUnclear;
  if (clear || output.mapCamera) return { selection: output, ambiguous: false };
  const objectIntent = [
    'map_focus',
    'map_camera',
    'vessel_highlights',
    'vessel_tracks',
    'vessel_detail',
    'vessel_list',
    'analysis',
    'ais_heatmap',
  ].includes(intent);
  if (!objectIntent) return { selection: output, ambiguous: false };
  const explicit = [
    ...new Set([...goal.matchAll(/(?<![\d.])([1-9]\d{8})(?![\d.])/g)].map((m) => m[1]!)),
  ];
  const explicitId = goal.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
  )?.[0];
  const wantsMemory = referential.test(goal) || bareTargetAction.test(goal);
  // A fresh named/type/model selector is an explicit object, even when a previous set exists.
  const selector = output.vesselSelector;
  const queryText = selector?.query?.replace(
    /刚才|刚刚|上次|上面|上述|前面|这批|那批|这些|那些|它们|该船|这艘|继续|再查|再统计|聚焦|高亮|查询|船舶|船|的|历史|轨迹|航线|[，,。\s]/g,
    '',
  );
  const explicitSelector =
    !!selector &&
    (!!selector.model ||
      !!selector.shipTypes?.length ||
      !!selector.mmsis?.length ||
      !!queryText ||
      !wantsMemory);
  if (/型号|船名|名称|呼号|MMSI|IMO|船型/i.test(goal) && !selector && !explicit.length)
    return { selection: output, ambiguous: false };
  let mmsis: string[] | undefined;
  let targets = output.focusTargets;
  let source: string | undefined;
  if (explicitId) {
    output.focusTargets = [
      {
        kind: /事件/.test(goal) ? 'event' : /情报/.test(goal) ? 'intelligence' : 'route',
        id: explicitId,
      },
    ];
    delete output.mmsis;
    delete output.vesselSelector;
    return { selection: output, ambiguous: false, source: 'explicit' };
  } else if (explicit.length) {
    mmsis = explicit;
    targets = explicit.map((id) => ({ kind: 'vessel', id }));
    source = 'explicit';
  } else if (explicitSelector) return { selection: output, ambiguous: false, source: 'explicit' };
  else if (output.mmsis?.length || output.focusTargets?.length) {
    mmsis =
      output.mmsis ??
      output.focusTargets?.filter((ref) => ref.kind === 'vessel').map((ref) => ref.id);
    source = 'submitted';
  } else if (
    wantsMemory &&
    (submitted?.selectedTargets?.length || submitted?.selectedMmsis?.length)
  ) {
    targets = submitted.selectedTargets;
    mmsis =
      submitted.selectedMmsis ??
      targets?.filter((ref) => ref.kind === 'vessel').map((ref) => ref.id);
    source = 'submitted';
  } else if (wantsMemory && memory) {
    const compatible = memory.objectSets.filter(
      (set) =>
        set.querySucceeded !== false &&
        (['map_focus', 'map_camera'].includes(intent) || set.kind === 'vessels'),
    );
    const latest = Math.max(-1, ...compatible.map((set) => set.turnSeq));
    const candidates = compatible.filter((set) => set.turnSeq === latest);
    if (candidates.length > 1) return { selection: output, ambiguous: true };
    const candidate = candidates[0];
    if (candidate) {
      mmsis = candidate.members.flatMap((member) =>
        member.kind === 'vessel' ? [member.mmsi] : [],
      );
      targets = candidate.targets;
      if (!options.explicitScope && targets?.some((ref) => ref.kind === 'region')) {
        const previous = AgentSelectionSchema.safeParse(memory.conditions.selection).data;
        if (previous?.region) output.region = previous.region;
      }
      source = candidate.id;
    }
  }
  if (
    (mmsis?.length ?? 0) > (intent === 'vessel_tracks' ? 50 : 100) ||
    (targets?.length ?? 0) > 100
  )
    return { selection: output, ambiguous: false, tooMany: true, source };
  if (mmsis?.length) {
    output.mmsis = mmsis;
    output.vesselSelector = { mmsis: output.mmsis };
    if (intent === 'map_focus')
      output.focusTargets = targets?.length
        ? targets
        : output.mmsis.map((id) => ({ kind: 'vessel', id }));
    if (['map_focus', 'map_camera', 'vessel_highlights', 'vessel_detail'].includes(intent))
      delete output.bbox;
  } else if (targets?.length && ['map_focus', 'map_camera'].includes(intent))
    output.focusTargets = targets;
  if (memory && isMemoryContinuation(goal)) {
    const previous = AgentSelectionSchema.safeParse(memory.conditions.selection).data;
    if (previous) {
      const inherited: AgentSelection = {};
      // Conditions are inherited independently of objects. Current explicit input has priority.
      for (const key of [
        'bbox',
        'region',
        'vesselCircle',
        'filters',
        'timeRange',
        'intelligenceTimeRange',
      ] as const) {
        if (
          (options.explicitScope ||
            /当前.*(?:视野|区域)|(?:视野|视图)内|新区域|所选区域/.test(goal)) &&
          ['bbox', 'region', 'vesselCircle'].includes(key)
        )
          continue;
        if (previous[key] !== undefined && output[key] === undefined)
          Object.assign(inherited, { [key]: previous[key] });
      }
      output = { ...inherited, ...output };
      if (
        !options.explicitScope &&
        referential.test(goal) &&
        !/当前.*(?:视野|区域)|视野内|新区域|所选区域/.test(goal)
      ) {
        if (previous.bbox) output.bbox = previous.bbox;
        if (previous.region) output.region = previous.region;
        if (previous.vesselCircle) output.vesselCircle = previous.vesselCircle;
      }
      if (output.region?.kind === 'circle' || output.region?.kind === 'polygon') delete output.bbox;
      if (output.vesselCircle) {
        delete output.region;
        delete output.bbox;
      }
    }
  }
  if (
    mmsis?.length &&
    ['map_focus', 'map_camera', 'vessel_highlights', 'vessel_detail'].includes(intent)
  )
    delete output.bbox;
  return { selection: output, ambiguous: false, ...(source ? { source } : {}) };
}

/** Stable preferences come only from first-person user statements and remain proposed. */
export function stablePreferenceCandidate(goal: string): string | null {
  if (parseMemoryInstruction(goal) || goal.length > 1000) return null;
  return /^(?:我(?:平时|通常|一直|一般|更|比较|习惯|喜欢|希望)|以后(?:请|默认|都)|默认(?:请|使用|采用|查看|显示))/.test(
    goal.trim(),
  )
    ? goal.trim()
    : null;
}
