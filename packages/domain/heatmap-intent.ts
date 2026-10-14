import type { AgentSelection } from '../contracts/agent';
import { AgentTimeRangeSchema } from '../contracts/agent';

const clockTimeHint = /[零〇一二两三四五六七八九十百半几数\d０-９]+\s*[时点分秒]/u;

const temporalHint =
  /最近|过去|以前|之前|以后|之后|近期|昨天|今天|明天|前天|前几|这几|上周|本周|上月|本月|今年|去年|凌晨|早上|晚上|上午|下午|中午|今晚|今早|昨晚|昨夜|傍晚|夜间|早晨|早间|晚间|半夜|清晨|每天|每日|每周|每月|每年|截至|截止|至今|周[一二三四五六日天]|(?:前|近|后|未来|这|上|下|本)[零〇一二两三四五六七八九十百半几数\d]*[天日周月年时]|小时|分钟|\d+\s*[天日周月年点]|\d{1,2}[:：]\d{2}|\d{4}[-/]|时间|时段|UTC|北京时间/i;

/** Parse a deliberately small grammar locally; ambiguous prose never becomes a guessed window. */
export function heatmapSelection(goal: string, now: Date): AgentSelection {
  const unclear = { heatmapTimeUnclear: true } as const;
  const text = goal.trim();
  const nowMs = now.getTime();
  let from: number;
  let to = nowMs;
  const stamps = [
    ...text.matchAll(
      /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2}(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?/g,
    ),
  ];
  const relatives = [...text.matchAll(/(?:最近|过去|近)\s*(\d+(?:\.\d+)?)\s*(小时|天)/g)];
  const relative = relatives[0];
  if (relatives.length > 1 || (relative && (stamps.length > 0 || /昨天/.test(text))))
    return unclear;
  const yesterday = [...text.matchAll(/昨天/g)];
  if (yesterday.length > 1 || (yesterday.length && /UTC/i.test(text))) return unclear;
  const consumed = stamps.length ? stamps : relative ? [relative] : yesterday;
  let remainder = text;
  for (const match of consumed) {
    const suffix = text.slice(match.index! + match[0].length);
    if (/^\s*(?:之前|之后|以前|以后|前|后|以上|以下|以内|以外|以来|起|为止|开始|结束)/.test(suffix))
      return unclear;
    if (!stamps.length && /^\s*(?:到|至)/.test(suffix)) return unclear;
    remainder = remainder.replace(match[0], ' ');
  }
  if (consumed.length) remainder = remainder.replace(/北京时间|UTC/gi, ' ');
  // A recognized fragment is valid only when no other temporal qualifier remains.
  if (temporalHint.test(remainder) || clockTimeHint.test(remainder)) return unclear;
  if (stamps.length) {
    if (stamps.length !== 2) return unclear;
    if (/北京时间/.test(text) && /UTC/i.test(text) && stamps.some((stamp) => !stamp[4]))
      return unclear;
    const parsed = stamps.map((match) => {
      const zone = match[4] ?? (/北京时间/.test(text) ? '+08:00' : /UTC/i.test(text) ? 'Z' : null);
      if (!zone) return NaN;
      const datePart = new Date(`${match[1]}T00:00:00Z`);
      if (!Number.isFinite(datePart.getTime()) || datePart.toISOString().slice(0, 10) !== match[1])
        return NaN;
      return Date.parse(`${match[1]}T${match[2]}${match[3] ?? ':00'}${zone}`);
    });
    [from, to] = parsed as [number, number];
  } else if (relative) {
    const hours = Number(relative[1]) * (relative[2] === '天' ? 24 : 1);
    from = nowMs - hours * 3_600_000;
  } else if (/昨天/.test(text)) {
    to = Math.floor((nowMs + 8 * 3_600_000) / 86_400_000) * 86_400_000 - 8 * 3_600_000;
    from = to - 86_400_000;
  } else {
    from = nowMs - 24 * 3_600_000;
  }
  if (!Number.isFinite(new Date(from).getTime()) || !Number.isFinite(new Date(to).getTime()))
    return unclear;
  const range = AgentTimeRangeSchema.safeParse({
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
  });
  return range.success && to <= nowMs ? { timeRange: range.data } : unclear;
}
