import type { AgentSelection } from '../contracts/agent';
import { VesselTracksSelectorSchema } from '../contracts/vessel-tracks';
import { heatmapSelection } from './heatmap-intent';

/** Deliberately local syntax: names stay query terms; models require an explicit label. */
export function vesselTracksSelection(goal: string, now: Date): AgentSelection {
  const temporal = heatmapSelection(goal, now);
  const selection: AgentSelection = temporal.heatmapTimeUnclear
    ? { tracksTimeUnclear: true }
    : { timeRange: temporal.timeRange };
  if (/不要|别(?:再|帮我)?(?:绘制|显示|生成|查询)|无需|不用/.test(goal)) return selection;
  if (
    [...goal.matchAll(/MMSI\s*[:：]?\s*(\d+)/gi)].some(
      (m) => !/[1-9]\d{8}$/.test(m[1]!) || m[1]!.length !== 9,
    )
  )
    return selection;
  if ([...goal.matchAll(/IMO\s*[:：]?\s*(\d+)/gi)].some((m) => m[1]!.length !== 7))
    return selection;
  let text = goal
    .replace(/(?:最近|过去|近)\s*\d+(?:\.\d+)?\s*(?:小时|天)/g, ' ')
    .replace(
      /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?/g,
      ' ',
    )
    .replace(/昨天|昨晚|昨夜|今天|北京时间|UTC/gi, ' ');
  const selector: { shipTypes?: number[]; mmsis?: string[]; query?: string; model?: string } = {};
  text = text.replace(/([A-Za-z0-9][A-Za-z0-9-]{1,30})型(?:船舶|舰艇|船|舰)?/g, '型号$1 ');
  const model = text.match(
    /(?:具体)?(?:型号|船舶型号)(?:为)?\s*[:：]?\s*[“「"']?([^“”「」"'\s，,。]+?)(?=\s|[”」"']|的?(?:船舶|舰艇|船|舰)|的?(?:历史)?(?:航线|轨迹)|$)/,
  );
  if (model) {
    selector.model = model[1];
    text = text.replace(model[0], ' ');
  }
  const quotedName = text.match(/(?:船名|名称|呼号)\s*[:：]?\s*[“「"']([^”」"']+)[”」"']/);
  const name =
    quotedName ??
    text.match(
      /(?:船名|名称|呼号)\s*[:：]?\s*[“「"']?([^“”「」"'\s，,。]+?)(?=\s|[”」"']|的?(?:历史)?(?:航线|轨迹)|$)/,
    );
  if (name) {
    selector.query = name[1];
    text = text.replace(name[0], ' ');
  }
  const codes = [
    ...text.matchAll(/(?:AIS\s*)?船型(?:编码|代码)?(?:为)?\s*[:：]?\s*(\d{1,2})(?!\d)/gi),
  ];
  if (codes.length) {
    selector.shipTypes = [...new Set(codes.map((m) => Number(m[1])))];
    for (const m of codes) text = text.replace(m[0], ' ');
  } else {
    const types = new Set<number>();
    for (const [label, first, last] of [
      ['货船', 70, 79],
      ['油轮|油船', 80, 89],
      ['渔船', 30, 30],
      ['客船', 60, 69],
    ] as const) {
      const pattern = new RegExp(label, 'g');
      if (pattern.test(text)) {
        for (let i = first; i <= last; i++) types.add(i);
        text = text.replace(pattern, ' ');
      }
    }
    if (types.size) selector.shipTypes = [...types];
  }
  const mmsis = [...text.matchAll(/(?<!\d)(?:MMSI\s*[:：]?\s*)?([1-9]\d{8})(?!\d)/gi)];
  if (mmsis.length) {
    selector.mmsis = [...new Set(mmsis.map((m) => m[1]!))];
    for (const m of mmsis) text = text.replace(m[0], ' ');
  }
  const imo = text.match(/IMO\s*[:：]?\s*(?<!\d)(\d{7})(?!\d)/i);
  if (imo && name) return selection;
  if (imo) {
    selector.query = imo[1];
    text = text.replace(imo[0], ' ');
  }
  text = text
    .replace(
      /当前(?:地图|海图)?(?:视野|视图)|所选区域|这个区域|当前区域|(?:历史|批量|船舶)?(?:航线|轨迹)|船名|名称|呼号|查询|绘制|生成|显示|展示|查找|看看|请帮我|帮我|请|所有|全部|船舶|的|[“”「」"'，,。:：]/g,
      ' ',
    )
    .trim();
  if (text && (selector.query || selector.model || selector.mmsis)) return selection;
  if (
    !selector.query &&
    !selector.model &&
    !selector.mmsis &&
    text &&
    !/^(?:那些|这些|这种|那种|某种|某|选中|选定|这艘|该船|当前)$/.test(text)
  )
    selector.query = text.replace(/\s+/g, ' ').slice(0, 200);
  const parsed = VesselTracksSelectorSchema.safeParse(selector);
  if (parsed.success) selection.vesselSelector = parsed.data;
  return selection;
}
