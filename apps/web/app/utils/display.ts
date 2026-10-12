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
export function dateLabel(value: string | null | undefined) {
  return value
    ? new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'UTC' }) + ' UTC'
    : '—';
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
