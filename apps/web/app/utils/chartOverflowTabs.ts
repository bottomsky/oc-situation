export function partitionChartTabs<T extends string>(
  tabs: readonly { id: T; width: number }[],
  selected: T,
  availableWidth: number,
  gap: number,
  triggerWidth: number,
): { visible: T[]; overflow: T[] } {
  const totalWidth =
    tabs.reduce((sum, tab) => sum + tab.width, 0) + Math.max(0, tabs.length - 1) * gap;
  if (totalWidth <= availableWidth) return { visible: tabs.map((tab) => tab.id), overflow: [] };

  const active = tabs.find((tab) => tab.id === selected) ?? tabs[0];
  const visible = new Set<T>(active ? [active.id] : []);
  let usedWidth = triggerWidth + (active ? active.width + gap : 0);
  for (const tab of tabs) {
    if (tab.id === active?.id) continue;
    if (usedWidth + tab.width + gap <= availableWidth) {
      visible.add(tab.id);
      usedWidth += tab.width + gap;
    }
  }
  return {
    visible: tabs.filter((tab) => visible.has(tab.id)).map((tab) => tab.id),
    overflow: tabs.filter((tab) => !visible.has(tab.id)).map((tab) => tab.id),
  };
}
