import {
  MARINE_SAMPLE_POINTS,
  type IntelligenceSearchSpec,
} from '../contracts/intelligence-search';
import type { AgentSelection } from '../contracts/agent';

export function isIntelligenceQuestion(text: string): boolean {
  return (
    /情报|新闻|通告|航行警告|天气|海况|浪高|波浪|预报|事故|碰撞|搁浅|沉船|地震|台风|洪水|海啸|气旋|灾害|news|forecast|marine|flood|tsunami|cyclone/i.test(
      text,
    ) || /(?:查|找|有|最近|近期|哪些).*(?:公告|港口限制)/.test(text)
  );
}

/** Deterministic local parsing: free text is used only for local indexed retrieval. */
export function intelligenceSelection(text: string, now = new Date()): AgentSelection {
  const marine = /海况|浪高|波浪|预报|forecast|marine/i.test(text);
  const spec: IntelligenceSearchSpec = { kind: marine ? 'marine' : 'events' };
  const categories = [
    ['navigation-warning', /航行警告|navigation.warning/i],
    ['port-restriction', /港口限制|封港|禁航/i],
    ['weather', /天气|气象|台风|weather/i],
    ['security', /安全|海盗|security/i],
    ['environment', /环境|污染|environment/i],
    ['incident', /事故|碰撞|incident/i],
    ['notice', /公告|通告|notice/i],
  ] as const;
  const category = categories.find(([, pattern]) => pattern.test(text));
  if (category) spec.category = category[0];
  if (/事故|碰撞|搁浅|沉船|海难|accident|collision|grounding|shipwreck/i.test(text)) {
    spec.category = 'incident';
    spec.keyword = '船舶事故';
  } else if (/台风|气旋|typhoon|hurricane|cyclone/i.test(text)) {
    spec.category = 'weather';
    spec.keyword = '台风';
  } else if (/洪水|flood/i.test(text)) {
    spec.category = 'environment';
    spec.keyword = '洪水';
  } else if (/海啸|tsunami/i.test(text)) {
    spec.category = 'weather';
    spec.keyword = '海啸';
  } else if (/地震|earthquake/i.test(text)) {
    spec.category = 'environment';
    spec.keyword = '地震';
  }
  const point = MARINE_SAMPLE_POINTS.find((p) =>
    p.aliases.some((alias) => text.toLowerCase().includes(alias.toLowerCase())),
  );
  if (marine && point) spec.samplePointId = point.id;
  else if (point) {
    spec.locationKeyword = point.aliases[0];
    const regions: Record<string, [number, number, number, number]> = {
      bohai: [117.5, 37, 122, 41],
      'yellow-sea': [120, 31, 127, 40],
      'east-china-sea': [120, 23, 130, 34],
      'taiwan-strait': [116.5, 21, 122.5, 26],
      'north-south-china-sea': [105, 3, 121, 23],
      'beibu-gulf': [105, 17, 110.5, 22],
    };
    spec.bbox = regions[point.id];
  }
  // Full question remains inside the platform; category searches do not require an exact sentence match.
  const quoted = text.match(/[“"「]([^”"」]{1,300})[”"」]/)?.[1];
  if (quoted) spec.keyword = quoted;
  else if (!category && !marine && !point && !spec.keyword) {
    const keyword = text
      .replace(
        /\d{4}-\d{1,2}-\d{1,2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?/g,
        '',
      )
      .replace(
        /(?:最近|过去|近|未来|接下来)\s*(?:\d+|[一二两三四五六七八九十]+)\s*(?:小时|天|周|个月|月|年)/g,
        '',
      )
      .replace(
        /去年|前年|今年|明年|春节|国庆|期间|上个月|本月|下个月|上周|本周|下周|昨天|前天|今天|明天|后天|至|到/g,
        '',
      )
      .replace(
        /(?:请|帮我|查询|查找|搜索|找一下|最近|近期|情报|新闻|有哪些|有什么|一下|的|？|\?)/g,
        '',
      )
      .trim();
    if (keyword && !/^\d+天$/.test(keyword)) spec.keyword = keyword.slice(0, 300);
  }
  const count = text.match(/(?:最近|过去|近|未来|接下来)\s*(\d+)\s*(小时|天|周|个月|月)/);
  const chineseDays = /(?:最近|过去|近|未来|接下来)(一|两|二|三|四|五|六|七|八|九|十)(天|周)/.exec(
    text,
  );
  const unit = count?.[2] ?? chineseDays?.[2];
  const rawCount = count
    ? Number(count[1])
    : chineseDays
      ? ({ 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[
          chineseDays[1]!
        ] ?? 7)
      : 7;
  const n = Math.max(1, Math.min(36500, rawCount));
  const duration =
    n *
    (unit === '小时'
      ? 3600_000
      : unit === '周'
        ? 7 * 86400_000
        : /月/.test(unit ?? '')
          ? 30 * 86400_000
          : 86400_000);
  const datePattern =
    /\b(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(Z|[+-]\d{2}:\d{2})?)?/g;
  const dates = [...text.matchAll(datePattern)];
  const relativePhrase =
    /(?:最近|过去|近|未来|接下来)\s*[^，。？！,.?!\s]{1,8}(?:小时|天|周|个月|月|年)/.test(text);
  let unclear =
    /去年|前年|今年|明年|春节|国庆|节期间|上个月|本月|下个月|上周|本周|下周|昨天|前天|今天|后天|\d{4}年|\d{1,2}月\d{1,2}日/.test(
      text,
    ) ||
    (relativePhrase && !count && !chineseDays) ||
    rawCount < 1 ||
    rawCount > 36500;
  let from = new Date(now.getTime() - duration).toISOString();
  let to = now.toISOString();
  if (marine) {
    from = now.toISOString();
    to = new Date(now.getTime() + (count || chineseDays ? duration : 3 * 86400_000)).toISOString();
  }
  if (/明天/.test(text)) {
    if (marine) {
      const nextMidnight =
        Math.floor((now.getTime() + 8 * 3600_000) / 86400_000) * 86400_000 -
        8 * 3600_000 +
        86400_000;
      from = new Date(nextMidnight).toISOString();
      to = new Date(nextMidnight + 86400_000).toISOString();
    } else unclear = true;
  }
  const dateMentions = [...text.matchAll(/\b\d{4}-\d{1,2}-\d{1,2}/g)];
  if (dateMentions.length !== dates.length) unclear = true;
  if (dates.length) {
    const parseDate = (m: RegExpExecArray) => {
      // Date normalizes February 30; detect that rather than silently querying March.
      if (new Date(m[1] + 'T00:00:00Z').toISOString().slice(0, 10) !== m[1])
        throw new Error('invalid_date');
      return new Date(m[1] + 'T' + (m[2] ?? '00:00:00') + (m[3] ?? '+08:00')).toISOString();
    };
    try {
      const start = parseDate(dates[0]!);
      const end =
        dates.length === 2
          ? parseDate(dates[1]!)
          : new Date(Date.parse(start) + 86400_000).toISOString();
      if (
        dates.length > 2 ||
        start >= end ||
        (dates.length === 1 && (dates[0]![2] || /至|到|through|until/i.test(text)))
      )
        unclear = true;
      else {
        from = start;
        to = end;
      }
    } catch {
      unclear = true;
    }
  }
  if (unclear)
    return {
      purpose: 'intelligence_search',
      intelligenceQuery: spec,
      intelligenceTimeUnclear: true,
    };
  if (marine) {
    spec.forecastFrom = from;
    spec.forecastTo = to;
  } else {
    spec.from = from;
    spec.to = to;
  }
  return {
    purpose: 'intelligence_search',
    intelligenceQuery: spec,
    intelligenceTimeRange: { from, to },
  };
}
