import type { UserRole, TrackResponse } from '@ais/contracts';
export function canOperate(role: UserRole | undefined) {
  return role === 'operator' || role === 'admin';
}
export function trackFrame(track: TrackResponse | null, index: number) {
  const points = track?.segments.flatMap((s) => s.points) ?? [];
  return points[Math.max(0, Math.min(points.length - 1, index))] ?? null;
}
export function queryString(values: Record<string, string | number | undefined>) {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== '') q.set(key, String(value));
  return q.size ? `?${q}` : '';
}
export function errorLabel(status: number, path?: string) {
  if (status === 401 && path === '/auth/login') return '用户名或密码不正确，请重试';
  if (status === 401) return '登录已过期，请重新登录';
  if (status === 403) return '当前账号没有此操作权限';
  if (status === 409) return '操作条件未满足，请检查来源与任务状态';
  if (status === 400) return '输入参数不符合要求，请检查后重试';
  return '服务暂时无法完成请求，请重试';
}
export function businessError(message: unknown, status: number): { message: string; code: string } {
  const text = typeof message === 'string' ? message : '';
  const values: [RegExp, string, string][] = [
    [
      /revision conflict|revision_conflict/i,
      'revision_conflict',
      '数据版本已更新，请读取最新版本后合并；当前草稿已保留。',
    ],
    [
      /operation.*reused|operation_conflict/i,
      'operation_conflict',
      '该操作编号已用于其他内容，请刷新详情后重新提交。',
    ],
    [
      /plan_not_completed|plan.*not.*completed/i,
      'plan_not_completed',
      '规划尚未完成，请等待候选方案生成后保存。',
    ],
    [/not.found|not_found/i, 'not_found', '对象已不存在或当前账号无权访问，请刷新列表。'],
    [
      /Primary source must belong/i,
      'invalid_primary_source',
      '请选择当前事件或合并目标所属的来源。',
    ],
    [
      /Released field requires/i,
      'missing_source_suggestion',
      '该字段暂无来源建议值，请保留人工值。',
    ],
    [/Cannot merge an event into itself/i, 'same_merge_target', '请选择其他事件作为合并目标。'],
  ];
  const match = values.find(([pattern]) => pattern.test(text));
  return match
    ? { code: match[1], message: match[2] }
    : { code: `HTTP_${status}`, message: errorLabel(status) };
}
export function dateLabel(value: string | null | undefined) {
  return value
    ? new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'UTC' }) + ' UTC'
    : '—';
}
export function heatmapDateLabel(value: string) {
  return `${new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })} 北京时间`;
}
export const roleLabel = { admin: '管理员', operator: '操作员', viewer: '只读用户' };
export const statusLabel: Record<string, string> = {
  enabled: '已启用',
  disabled: '已停用',
  error: '异常',
  paused: '已暂停',
  queued: '等待执行',
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};
