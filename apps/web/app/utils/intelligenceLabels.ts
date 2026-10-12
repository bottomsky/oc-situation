export const categoryLabels: Record<string, string> = {
  'port-restriction': '港口限制',
  notice: '海事公告',
  'navigation-warning': '航行警告',
  weather: '气象海况',
  security: '安全事件',
  environment: '海洋环境',
  incident: '海事事故',
  other: '其他情报',
};
export const reviewLabels: Record<string, string> = {
  candidate: '待核实',
  confirmed: '已确认',
  rejected: '已驳回',
};
export const statusLabels: Record<string, string> = {
  active: '有效',
  revised: '已修订',
  withdrawn: '已撤回',
  expired: '已失效',
};
export const relationLabels: Record<string, string> = {
  'occurs-at': '发生位置',
  mentions: '提及对象',
  involves: '涉及对象',
  'applies-to': '适用范围',
  impacts: '影响认定',
};
export const originLabels: Record<string, string> = {
  source: '来源原文',
  rule: '规则识别',
  manual: '人工标注',
  legacy: '历史导入',
};
export const objectLabels: Record<string, string> = {
  vessel: '船舶',
  port: '港口',
  channel: '航道',
  area: '海域',
  facility: '设施',
};
export function safeOriginalUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function intelligenceSampleLabel(synthetic: unknown): string {
  return synthetic === true ? '样例数据' : '';
}
