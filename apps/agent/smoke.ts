import { executeAgent, type RuntimePorts } from './runtime';
import { agentEnvironment } from './index';
import type { AgentTask } from '../../packages/contracts/agent';
import type { AnalysisResult, TopicDataset } from '../../packages/contracts/topics';

// Synthetic fixtures only. No infrastructure connection, database query, or real AIS source is used.
const options = agentEnvironment();
if (!options.apiKey) throw new Error('请通过服务端环境提供 DEEPSEEK_API_KEY');
const to = new Date().toISOString();
const from = new Date(Date.now() - 24 * 3600_000).toISOString();
const task = {
  id: 'synthetic-task',
  sessionId: 'synthetic-session',
  ownerId: 'synthetic-owner',
  status: 'running',
  goal: '分析区域低速活动与公告关联',
  bbox: [120, 30, 122, 32],
  from,
  to,
  historyHours: 24,
  definitionId: null,
  generation: 1,
  modelCalls: 0,
  toolCalls: 0,
  resultVersion: 0,
  summaryResultVersion: null,
  summary: null,
  error: null,
  createdAt: to,
  updatedAt: to,
} satisfies AgentTask;
const dataset: TopicDataset = {
  from,
  to,
  queriedAt: to,
  ais: [0, 1, 2].map((index) => ({
    recordId: `synthetic-point-${index}`,
    vesselId: 'synthetic-vessel',
    mmsi: '413000001',
    occurredAt: new Date(Date.now() - (10 - index) * 60000).toISOString(),
    longitude: 121,
    latitude: 31,
    speedOverGround: 1,
    shipType: 70,
    raw: { synthetic: true },
  })),
  intelligence: [
    {
      id: 'synthetic-document',
      sourceId: 'synthetic-source',
      externalId: 'synthetic-notice',
      version: 1,
      status: 'active',
      title: '合成测试公告',
      kind: 'notice',
      effectiveFrom: from,
      effectiveTo: to,
      bbox: [120, 30, 122, 32],
      vesselTypes: [],
      mmsis: [],
      paragraphs: [{ id: 'synthetic-paragraph', text: '合成公告原文不发送模型' }],
      raw: { synthetic: true },
    },
  ],
};
let modelCalls = 0;
let toolCalls = 0;
let textDeltas = 0;
let savedResults: AnalysisResult[] = [];
let outcome: Parameters<RuntimePorts['finish']>[0] | undefined;
const steps: string[] = [];
const ports: RuntimePorts = {
  active: async () => true,
  reserve: async (kind, maximum) => {
    if (kind === 'model') {
      if (modelCalls >= maximum) return false;
      modelCalls++;
    } else {
      if (toolCalls >= maximum) return false;
      toolCalls++;
    }
    return true;
  },
  setDefinition: async () => true,
  reusePrevious: async () => null,
  saveStep: async (key) => {
    steps.push(key);
    return true;
  },
  query: async () => dataset,
  saveResults: async (results) => {
    savedResults = results;
    return 1;
  },
  finish: async (value) => {
    outcome = value;
    return true;
  },
};
await executeAgent({ task, steps: [], results: [] }, ports, {
  ...options,
  maxModelCalls: 12,
  maxToolCalls: 24,
  onTextDelta: () => {
    textDeltas++;
  },
});
const passed =
  outcome?.status === 'completed' &&
  modelCalls >= 2 &&
  toolCalls >= 2 &&
  savedResults.length === 1 &&
  textDeltas > 0 &&
  outcome.summaryResultVersion === 1;
process.stdout.write(
  JSON.stringify(
    {
      passed,
      model: options.model,
      modelCalls,
      toolCalls,
      textDeltas,
      results: savedResults.length,
      status: outcome?.status,
      summaryResultVersion: outcome?.summaryResultVersion,
      error: outcome?.error,
      tools: steps.filter((key) => key.startsWith('tool:')).map((key) => key.slice(5)),
      summary: outcome?.summary,
    },
    null,
    2,
  ) + '\n',
);
if (!passed) process.exitCode = 1;
