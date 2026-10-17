import type { UiOperation, UiState } from '../contracts/agent-ui';

export function isUiIntent(text: string) {
  if (/航线|历史轨迹|批量轨迹/.test(text)) {
    if (/关闭|隐藏|收起/.test(text)) return true;
    if (/(?:打开|展开|切换).*(?:面板|历史航线)$/.test(text)) return true;
    return /(?:恢复|展示|显示)(?:上次|已有|历史|之前|刚才)(?:的)?(?:航线|轨迹)|^(?:请)?(?:显示|恢复)(?:历史)?航线$/.test(
      text,
    );
  }
  return (
    /(?:关闭|隐藏|收起|打开|展开|切换|显示|定位).*(?:热力图|热度图|面板|浮窗|弹窗|窗口|图层|浮卡|条件框|选中船舶|这艘船|聊天|任务中心|主动推送|情报来源详情|研判证据详情|补充任务条件|来源详情|证据详情|船舶搜索|情报标绘|时间回放|图层控制)|(?:当前|现在|目前|哪些|什么).*(?:界面|窗口|弹窗|面板).*(?:打开|显示|状态)|(?:打开|显示)了哪些(?:界面|窗口|弹窗|面板)|(?:恢复|展示)(?:上次|已有|历史)热力图/.test(
      text,
    ) && !/(?:生成|计算|重新查询).*热力图/.test(text)
  );
}
export function resolveUiOperation(text: string, state: UiState): UiOperation | null | 'ambiguous' {
  if (
    !/关闭|隐藏|收起|打开|展开|切换|显示|定位|恢复|展示/.test(text) ||
    /哪些|什么|状态/.test(text)
  )
    return null;
  if (/不要|别|勿|不必|不用/.test(text)) return null;
  const close = /关闭|隐藏|收起/.test(text);
  if (/航线|历史轨迹|批量轨迹/.test(text)) {
    if (/面板/.test(text) || (!close && /打开|展开|切换/.test(text)))
      return {
        componentId: 'workspace.left',
        action: close ? 'close' : 'tab',
        ...(close ? {} : { tab: 'history-tracks' }),
      };
    return { componentId: 'chart.vessel-tracks', action: close ? 'close' : 'show' };
  }
  if (/热力图|热度图/.test(text))
    return {
      componentId: /网格|详情浮窗/.test(text) ? 'chart.heatmap.popup' : 'chart.heatmap',
      action: close ? 'close' : 'show',
    };
  if (/船舶搜索|情报标绘|时间回放|图层控制/.test(text))
    return {
      componentId: 'workspace.left',
      action: close ? 'close' : 'tab',
      ...(close
        ? {}
        : {
            tab: /船舶搜索/.test(text)
              ? ('search' as const)
              : /情报标绘/.test(text)
                ? ('intelligence' as const)
                : /时间回放/.test(text)
                  ? ('playback' as const)
                  : ('layers' as const),
          }),
    };
  if (/人工|左侧/.test(text))
    return { componentId: 'workspace.left', action: close ? 'close' : 'open' };
  if (/任务中心|主动推送|聊天/.test(text))
    return {
      componentId: 'workspace.right',
      action: close ? 'close' : 'tab',
      ...(close
        ? {}
        : { tab: /任务中心/.test(text) ? 'tasks' : /主动推送/.test(text) ? 'push' : 'chat' }),
    };
  if (/协同|协作|右侧/.test(text))
    return { componentId: 'workspace.right', action: close ? 'close' : 'open' };
  if (/条件/.test(text)) return { componentId: 'agent.input', action: close ? 'close' : 'open' };
  if (/回复|浮卡/.test(text))
    return { componentId: 'agent.reply', action: close ? 'close' : 'open' };
  if (/来源/.test(text))
    return close ? { componentId: 'agent.sources', action: 'close' } : 'ambiguous';
  if (/证据.*(?:弹窗|窗口|详情)/.test(text))
    return close ? { componentId: 'chart.evidence', action: 'close' } : 'ambiguous';
  if (/图层/.test(text) && !/船位|船舶|AIS|轨迹|证据/.test(text)) return 'ambiguous';
  if (/图层/.test(text))
    return {
      componentId: /轨迹/.test(text)
        ? 'chart.layers.tracks'
        : /证据/.test(text)
          ? 'chart.layers.evidence'
          : 'chart.layers.ais',
      action: close ? 'hide' : 'show',
    };
  if (/定位/.test(text)) return { componentId: 'chart.viewport', action: 'focus' };
  const popups = state.components.filter(
    (c) =>
      c.open &&
      [
        'agent.input',
        'agent.sources',
        'chart.evidence',
        'chart.choices',
        'chart.heatmap.popup',
        'agent.reply',
      ].includes(c.id),
  );
  const focused = popups.filter((c) => c.focused);
  const top =
    focused.length === 1
      ? focused
      : popups.filter((c) => c.order === Math.max(...popups.map((p) => p.order)));
  return close && top.length === 1 ? { componentId: top[0]!.id, action: 'close' } : 'ambiguous';
}
