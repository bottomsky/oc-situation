import type { RouteCoordinate } from '@ais/contracts';
export function reorderWaypoint(points: RouteCoordinate[], index: number, delta: number) {
  const next = points.map((p) => [...p] as RouteCoordinate);
  const target = index + delta;
  if (target >= 0 && target < next.length)
    [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
export function routePlanError(code: string | null) {
  const errors: Record<string, string> = {
    NO_CONNECTOR: '航点无法连接可通航网络，请靠近可用航路后重试。',
    ENDPOINT_RESTRICTED: '航点落入当前有效禁行区，请移动航点或检查约束。',
    ROUTE_BLOCKED: '规划航路受陆地或禁行区域阻断，请调整航点或约束。',
    WORKER_INTERRUPTED: '规划任务因服务重启中断，请重新规划。',
    DATASET_UNAVAILABLE: '海洋航路数据尚未就绪，请联系管理员导入数据后重试。',
    DATASET_UNPREPARED: '航路数据正在准备，请稍后重试；管理员可查看准备进度。',
    PLANNING_DISABLED: '自动航路规划尚未启用，请联系管理员。',
    DATA_MISSING: '当前区域缺少航路数据，请调整航点。',
    WAYPOINT_ON_LAND: '航点位于陆地，请将航点移至海面。',
    ON_LAND: '航点位于陆地，请将航点移至海面。',
    SNAP_FAILED: '航点无法连接可通航网络，请靠近可用航路后重试。',
    NO_ROUTE: '现有航点与禁行约束之间没有可通行航路，请调整航点或检查禁行区。',
    TIMEOUT: '规划超时，请缩小范围或减少航点后重试。',
  };
  const key = (code || '').toUpperCase();
  return (
    errors[key] ||
    (key.includes('LAND')
      ? errors.ON_LAND!
      : key.includes('DATA')
        ? errors.DATA_MISSING!
        : key.includes('TIME')
          ? errors.TIMEOUT!
          : key.includes('SNAP')
            ? errors.SNAP_FAILED!
            : '航路规划未完成，请检查航点、数据和禁行约束后重试。')
  );
}
export function routeChartHref(id: string, ask = false) {
  return `/?routeId=${encodeURIComponent(id)}${ask ? '&askRoute=1' : ''}`;
}
