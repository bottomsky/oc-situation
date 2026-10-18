import { z } from 'zod';
import { RouteCoordinateSchema } from '../contracts/routes';
import type { FocusTargetRef } from '../contracts/agent-focus';

export const BUSINESS_TOOLS = [
  'query_routes',
  'read_route',
  'plan_route',
  'create_route',
  'update_route',
  'query_events',
  'read_event',
  'create_event',
  'update_event',
] as const;
export type BusinessToolId = (typeof BUSINESS_TOOLS)[number];
export interface BusinessRequest {
  toolId: BusinessToolId;
  id?: string;
  search?: string;
  name?: string;
  title?: string;
  coordinate?: [number, number];
  waypoints?: [number, number][];
  status?: 'active' | 'resolved' | 'archived' | 'draft';
  summary?: string;
  category?: string;
  severity?: 'unknown' | 'low' | 'medium' | 'high' | 'critical';
  linkedMmsis?: string[];
}
/** Only the authenticated user's task goal is admitted; skill/model/source text never enters here. */
export function parseBusinessRequest(
  goal: string,
  refs: FocusTargetRef[] = [],
): BusinessRequest | null {
  const text = (goal ?? '').trim();
  const kind = /^(?:请)?(?:创建|新建|新增|修改|更新|将|把|查询|查找|搜索|查看|读取|规划|计划)/.test(
    text,
  );
  if (!kind || !/事件|航线/.test(text)) return null;
  const writeWithheld =
    /(?:不要|不必|无需|不用|别|先不|暂不|不)\s*(?:立即|马上|实际)?\s*(?:保存|执行|提交|创建|新建|新增|修改|更新)|(?:仅|只)(?:做)?(?:预览|演示|模拟|说明|草拟)/.test(
      text,
    );
  const event =
    /事件/.test(text) && (!/航线/.test(text) || text.indexOf('事件') < text.indexOf('航线'));
  if (
    !event &&
    /船舶|货船|油轮|客船|渔船|历史|轨迹|最近|过去|MMSI|\d{9}/i.test(text) &&
    !/计划航线|已保存航线/.test(text) &&
    !/^(?:请)?(?:规划|计划|创建|新建|新增|修改|更新|将|把)/.test(text)
  )
    return null;
  const selectedRefs = refs.filter((ref) => ref.kind === (event ? 'event' : 'route'));
  const id =
    text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0] ??
    (/选中|选定|(?:该|此|这个|这起|这条)事件|(?:该|此|这条|这个)(?:计划|已保存)?航线/.test(text)
      ? selectedRefs.length === 1
        ? selectedRefs[0]!.id
        : undefined
      : undefined);
  const pairs = [
    ...text.matchAll(/坐标\s*[:：]?\s*[（(]?\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)/g),
  ].map((m) => RouteCoordinateSchema.parse([Number(m[1]), Number(m[2])]));
  const name = text.match(/(?:保存为|名称|命名为)\s*[:：]?\s*[“"]?([^”"，,。\n]+)/)?.[1]?.trim();
  const title = text
    .match(
      /标题\s*[:：]?\s*[“"]?([^”"，,。\n]+?)(?=\s*(?:坐标|级别|严重程度|摘要|描述|分类|关联)|[”"，,。\n]|$)/,
    )?.[1]
    ?.trim();
  const summary = text
    .match(
      /(?:摘要|描述)\s*[:：]\s*[“"]?([^”"\n]+?)(?=\s*(?:坐标|级别|严重程度|分类|关联)|[”"\n]|$)/,
    )?.[1]
    ?.trim();
  const category = text.match(/分类\s*[:：]\s*([^，,。\s]+)/)?.[1];
  const severityText = text.match(
    /(?:级别|严重程度)\s*(?:改为|设为|为|[:：])?\s*(紧急|严重|高|中|低|未知|critical|high|medium|low|unknown)/,
  )?.[1];
  const severity = severityText
    ? (
        {
          紧急: 'critical',
          严重: 'critical',
          高: 'high',
          中: 'medium',
          低: 'low',
          未知: 'unknown',
          critical: 'critical',
          high: 'high',
          medium: 'medium',
          low: 'low',
          unknown: 'unknown',
        } as const
      )[severityText as '高']
    : undefined;
  const linkedMmsis = /关联(?:船舶|MMSI)/i.test(text)
    ? [...new Set([...text.matchAll(/(?<!\d)([1-9]\d{8})(?!\d)/g)].map((m) => m[1]!))]
    : undefined;
  const eventFields = {
    ...(summary ? { summary } : {}),
    ...(category ? { category } : {}),
    ...(severity ? { severity } : {}),
    ...(linkedMmsis ? { linkedMmsis } : {}),
  };
  if (event && /^(?:请)?(?:创建|新建|新增)事件/.test(text)) {
    if (writeWithheld) return null;
    return {
      toolId: 'create_event',
      ...(title ? { title } : {}),
      ...(pairs[0] ? { coordinate: pairs[0] } : {}),
      ...eventFields,
    };
  }
  if (event && /^(?:请)?(?:将|把|修改|更新)/.test(text)) {
    if (writeWithheld) return null;
    const statusText = text.match(
      /状态\s*(?:改为|设为|为|[:：])?\s*(已解决|解决|resolved|归档|archived|活动|active)/,
    )?.[1];
    const status =
      statusText && /已解决|解决|resolved/.test(statusText)
        ? 'resolved'
        : statusText && /归档|archived/.test(statusText)
          ? 'archived'
          : statusText && /活动|active/.test(statusText)
            ? 'active'
            : undefined;
    return {
      toolId: 'update_event',
      ...(id ? { id } : {}),
      ...(status ? { status } : {}),
      ...(title ? { title } : {}),
      ...(pairs[0] ? { coordinate: pairs[0] } : {}),
      ...eventFields,
    };
  }
  if (!event && /^(?:请)?(?:规划|计划|(?:创建|新建|新增)(?:计划)?航线)/.test(text))
    return {
      toolId:
        !writeWithheld && /并保存|保存为|^(?:请)?(?:创建|新建|新增)/.test(text)
          ? 'create_route'
          : 'plan_route',
      ...(pairs.length ? { waypoints: pairs } : {}),
      ...(name ? { name } : {}),
    };
  if (!event && /^(?:请)?(?:将|把|修改|更新)/.test(text)) {
    if (writeWithheld) return null;
    return {
      toolId: 'update_route',
      ...(id ? { id } : {}),
      ...(name ? { name } : {}),
      ...(/归档/.test(text)
        ? { status: 'archived' as const }
        : /启用|激活/.test(text)
          ? { status: 'active' as const }
          : {}),
    };
  }
  if (/^(?:请)?(?:查询|查找|搜索|查看|读取)/.test(text)) {
    const search = text
      .replace(/^(?:请)?(?:查询|查找|搜索|查看|读取)(?:一下)?\s*(?:事件|航线)\s*[:：]?\s*/, '')
      .replace(/[“”"]/g, '')
      .trim();
    return {
      toolId: event ? (id ? 'read_event' : 'query_events') : id ? 'read_route' : 'query_routes',
      ...(id ? { id } : search ? { search } : {}),
    };
  }
  return null;
}
export const BusinessToolInputSchema = z.strictObject({ selection: z.unknown().optional() });
