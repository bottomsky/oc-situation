import { isIntelligenceQuestion } from './intelligence-intent';
import type { TopicDefinitionId } from '../contracts/topics';
import type {
  AgentIntent,
  AgentPurpose,
  AgentSelection,
  AgentInputField,
} from '../contracts/agent';
import { classifyConversationIntent } from './agent-conversation';

/** Local intent extraction is deliberately finite: user prose never becomes a model prompt. */
export function classifyGoal(goal: string): TopicDefinitionId | null {
  const port = /港口|限制|禁航|port|restriction/i.test(goal);
  const slow = /低速|low.speed/i.test(goal);
  if (port && slow) return null;
  if (port) return 'port-restriction';
  if (slow || /区域.{0,6}(研判|公告关联)|公告关联|area.notice/i.test(goal))
    return 'area-low-speed-notice';
  return null;
}

export function classifyRequest(goal: string, previous: TopicDefinitionId | null) {
  const algorithm = classifyGoal(goal);
  const explanation = /^(?:请|帮我|请帮我)?(?:解释|说明|查看|解读|explain)/i.test(goal.trim());
  const summary = /^(?:请|帮我|请帮我)?(?:总结|概括|summari[sz]e)/i.test(goal.trim());
  const newRun = /重新|重跑|重算|新分析|(?:并|然后|再)(?:请)?(?:分析|研判|识别|检测)/.test(goal);
  // “上次低速分析” names a prior result; the noun 分析 is not an instruction to recompute.
  if ((explanation || summary) && !newRun) {
    if (!previous || (algorithm && algorithm !== previous)) return null;
    return { action: explanation ? 'explain_evidence' : 'summarize', algorithm: previous } as const;
  }
  if (algorithm && /分析|研判|识别|检测|关联|重新|重跑|analy[sz]e/i.test(goal))
    return { action: 'analyze', algorithm } as const;
  if (/重新|重跑|新分析|分析|研判/.test(goal) && !algorithm) return null;
  if (previous && !/重新|重跑|新分析/.test(goal)) {
    if (/证据|解释|为何|为什么|explain/i.test(goal))
      return { action: 'explain_evidence', algorithm: previous } as const;
    if (/总结|摘要|继续|summari[sz]e|continue/i.test(goal))
      return { action: 'summarize', algorithm: previous } as const;
  }
  return algorithm ? ({ action: 'analyze', algorithm } as const) : null;
}

export function derivePurposeIntent(purpose: AgentPurpose): AgentIntent {
  return purpose === 'vessel_list' ||
    purpose === 'vessel_detail' ||
    purpose === 'ais_heatmap' ||
    purpose === 'intelligence_search'
    ? purpose
    : 'analysis';
}
export function deriveAgentIntent(goal: string): { intent: AgentIntent; purpose?: AgentPurpose } {
  if (classifyConversationIntent(goal)) return { intent: 'conversation' };
  const text = goal.replace(/\s/g, '');
  const heatmap = /热力图|热度图|(?:AIS|船舶|船流).*密度图|heatmap/i.test(text);
  if (/定位|保存|删除|画区域/.test(text) || (/绘制/.test(text) && !heatmap))
    return { intent: 'unresolved' };
  const queryAgain = /重新(?:查询|查看|查)|再查(?:询)?|刷新(?:船舶|列表|查询|结果)/.test(text);
  if (heatmap && queryAgain) return { intent: 'ais_heatmap', purpose: 'ais_heatmap' };
  if (queryAgain && isIntelligenceQuestion(text))
    return { intent: 'intelligence_search', purpose: 'intelligence_search' };
  if (queryAgain && !/分析|研判|识别|检测/.test(text)) {
    if (/视野|区域|船舶列表|哪些船|多少船/.test(text))
      return { intent: 'vessel_list', purpose: 'vessel_list' };
    if (/选中|这艘|该船|MMSI|\d{9}/i.test(text))
      return { intent: 'vessel_detail', purpose: 'vessel_detail' };
  }
  if (
    /^(?:请|帮我|请帮我)?(?:解释|说明|解读|总结|概括|查看(?:.*(?:证据|结果))|explain|summari[sz]e)/i.test(
      text,
    ) &&
    !queryAgain &&
    !/重跑|重算|重新|新分析/.test(text)
  )
    return { intent: 'explain' };
  if (heatmap) return { intent: 'ais_heatmap', purpose: 'ais_heatmap' };
  if (
    !queryAgain &&
    /(?:这条|该|上条|上述|刚才|上次).*(?:公告|情报|结果|预报|新闻).*(?:依据|来源|证据|为什么)/.test(
      text,
    )
  )
    return { intent: 'explain' };
  if (isIntelligenceQuestion(text) && !/分析|研判|识别|检测|关联/.test(text))
    return { intent: 'intelligence_search', purpose: 'intelligence_search' };
  const algorithm = classifyGoal(text);
  if (algorithm && /分析|研判|识别|检测|关联|重新|重跑|analy[sz]e/i.test(text))
    return { intent: 'analysis', purpose: algorithm };
  if (/(船|MMSI|IMO|vessel|ship)/i.test(text)) {
    if (/哪些|多少|列表|全部|所有|list/i.test(text))
      return { intent: 'vessel_list', purpose: 'vessel_list' };
    if (/信息|详情|资料|选中|这艘|该船|\d{9}|detail/i.test(text))
      return { intent: 'vessel_detail', purpose: 'vessel_detail' };
  }
  if (algorithm) return { intent: 'analysis', purpose: algorithm };
  return { intent: 'unresolved' };
}
export function classifyAgentIntent(goal: string): AgentIntent {
  return deriveAgentIntent(goal).intent;
}
export function requiredAgentInputFields(
  selection: AgentSelection,
  intent: AgentIntent,
): AgentInputField[] {
  const actual = selection.purpose ? derivePurposeIntent(selection.purpose) : intent;
  if (actual === 'conversation' || actual === 'explain') return [];
  const fields: AgentInputField[] = [];
  if (
    actual === 'intelligence_search' &&
    (!selection.intelligenceQuery ||
      selection.intelligenceObjectUnclear ||
      (selection.intelligenceQuery.kind === 'marine' && !selection.intelligenceQuery.samplePointId))
  )
    fields.push('topic');
  if (actual === 'intelligence_search' && selection.intelligenceTimeUnclear) fields.push('time');
  if (actual === 'unresolved' || (actual === 'analysis' && !selection.purpose)) fields.push('goal');
  if (
    (actual === 'vessel_list' || actual === 'analysis' || actual === 'ais_heatmap') &&
    !selection.bbox
  )
    fields.push('region');
  if (actual === 'vessel_detail' && !selection.mmsis?.length) fields.push('vessels');
  if (actual === 'analysis' && !selection.timeRange) fields.push('time');
  if (actual === 'ais_heatmap' && (!selection.timeRange || selection.heatmapTimeUnclear))
    fields.push('time');
  return fields;
}
