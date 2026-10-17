import type { AgentSession } from '@ais/contracts';

export interface AgentHistoryGroup {
  label: string;
  items: AgentSession[];
}

function calendarDay(date: Date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

/** Session creation time is the only timestamp exposed by the session list API. */
export function groupAgentHistory(
  sessions: readonly AgentSession[],
  search = '',
  now = new Date(),
): AgentHistoryGroup[] {
  const query = search.trim().toLocaleLowerCase();
  const groups: AgentHistoryGroup[] = [
    { label: '今天', items: [] },
    { label: '最近 7 天', items: [] },
    { label: '更早', items: [] },
  ];
  const today = calendarDay(now);
  const matches = sessions
    .filter((session) => !query || session.title.toLocaleLowerCase().includes(query))
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const session of matches) {
    const days = today - calendarDay(new Date(session.createdAt));
    groups[days <= 0 ? 0 : days < 7 ? 1 : 2]!.items.push(session);
  }
  return groups.filter((group) => group.items.length);
}

export function agentHistoryTime(createdAt: string, now = new Date()) {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat(
    'zh-CN',
    calendarDay(date) === calendarDay(now)
      ? { hour: '2-digit', minute: '2-digit', hour12: false }
      : { month: '2-digit', day: '2-digit' },
  ).format(date);
}
