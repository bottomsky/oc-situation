import {
  DynamicSkillDefinitionSchema,
  type DynamicSkillDefinition,
  type DynamicSkillToolDescriptor,
} from '../contracts/dynamic-skills';
import { uiOperationAllowed } from '../contracts/agent-ui';

const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const vesselClasses = new Set(['cargo', 'tanker', 'passenger', 'fishing']);
const taskBound =
  /^(?:bbox|mmsis?|imo|vessels?|region|coordinates?|latitude|longitude|lat|lon|from|to|timeRange|hours|historyHours|apiKey|token|secret|password|credentials|authorization)$/i;
const reference =
  /^(?:input\.selection(?:\.[a-zA-Z][a-zA-Z0-9_]*)*|steps\.[a-z][a-z0-9_-]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)*)$/;

/** Validates the data-only program against the actual trusted host tools. */
export function validateDynamicSkillDefinition(
  input: unknown,
  tools: readonly DynamicSkillToolDescriptor[],
): DynamicSkillDefinition {
  const definition = DynamicSkillDefinitionSchema.parse(input);
  if (new TextEncoder().encode(JSON.stringify(definition)).byteLength > 524_288)
    throw new Error('技能定义超过大小上限');
  for (const content of [definition.body, ...Object.values(definition.references)])
    if (new TextEncoder().encode(content).byteLength > 65_536)
      throw new Error('技能文档超过大小上限');
  const catalog = new Map(tools.map((tool) => [tool.id, tool]));
  if (new Set(definition.toolIds).size !== definition.toolIds.length)
    throw new Error('技能工具声明重复');
  if (
    new Set(definition.requiredInputs).size !== definition.requiredInputs.length ||
    Object.keys(definition.references).length > 16
  )
    throw new Error('技能输入声明重复或参考资料数量超限');
  for (const id of definition.toolIds)
    if (!catalog.has(id) || /^(?:skills?[.:_]|publish|create_skill)/i.test(id))
      throw new Error('技能包含未授权工具');
  const seen = new Set<string>();
  const walk = (value: unknown, key: string, depth: number): void => {
    if (depth > 12) throw new Error('技能输入嵌套过深');
    if (value && typeof value === 'object' && !Array.isArray(value) && '$ref' in value) {
      const fields = Object.keys(value);
      const path = (value as { $ref: unknown }).$ref;
      if (
        fields.length !== 1 ||
        typeof path !== 'string' ||
        !reference.test(path) ||
        path.split('.').some((part) => reserved.has(part))
      )
        throw new Error('技能引用路径无效');
      if (path.startsWith('steps.') && !seen.has(path.split('.')[1]!))
        throw new Error('技能只能引用先前步骤');
      return;
    }
    if (reserved.has(key) || (taskBound.test(key) && value !== null))
      throw new Error('任务参数与凭据必须由宿主引用绑定');
    if (Array.isArray(value)) value.forEach((item) => walk(item, '', depth + 1));
    else if (value && typeof value === 'object')
      for (const [child, item] of Object.entries(value)) walk(item, child, depth + 1);
  };
  for (const step of definition.steps) {
    const tool = catalog.get(step.toolId);
    if (
      seen.has(step.id) ||
      !tool ||
      !definition.toolIds.includes(step.toolId) ||
      !tool.allowedPhases.includes('skill')
    )
      throw new Error('技能步骤或工具阶段无效');
    if (step.artifactKind && !tool.artifactKinds.includes(step.artifactKind))
      throw new Error('工具产物类型不匹配');
    if (
      Object.keys(step.input).some(
        (key) => !['selection', 'vessels', 'vesselClass', 'vesselClasses'].includes(key),
      )
    )
      throw new Error('工具输入模板包含未知参数');
    if (
      step.input.vesselClass !== undefined &&
      (step.toolId !== 'query_vessels' ||
        typeof step.input.vesselClass !== 'string' ||
        !vesselClasses.has(step.input.vesselClass))
    )
      throw new Error('船舶类别仅限船舶查询的已注册语义筛选');
    if (step.input.vesselClasses !== undefined) {
      const classes = step.input.vesselClasses;
      if (
        step.toolId !== 'query_vessels' ||
        step.input.vesselClass !== undefined ||
        !Array.isArray(classes) ||
        classes.length < 1 ||
        classes.length > 4 ||
        new Set(classes).size !== classes.length ||
        classes.some((item) => typeof item !== 'string' || !vesselClasses.has(item))
      )
        throw new Error('船舶类别集合必须为船舶查询中互不重复的注册类别，并与单类别字段互斥');
    }
    if (
      step.input.selection !== undefined &&
      JSON.stringify(step.input.selection) !== JSON.stringify({ $ref: 'input.selection' })
    )
      throw new Error('工具范围必须引用宿主任务参数');
    if (step.input.vessels !== undefined) {
      const value = step.input.vessels;
      const path =
        value && typeof value === 'object' && !Array.isArray(value) && '$ref' in value
          ? value.$ref
          : null;
      const prior =
        typeof path === 'string'
          ? definition.steps.find((entry) => entry.id === path.slice(6))
          : undefined;
      if (
        typeof path !== 'string' ||
        !path.startsWith('steps.') ||
        !seen.has(path.slice(6)) ||
        prior?.toolId !== 'query_vessels'
      )
        throw new Error('船舶依赖必须引用先前船舶查询结果');
    }
    if (
      step.ui &&
      (!step.artifactKind || !uiOperationAllowed(step.ui) || step.ui.action !== 'show')
    )
      throw new Error('技能展示操作无效');
    if (
      step.ui &&
      !(
        (step.artifactKind === 'vessel_tracks' && step.ui.componentId === 'chart.vessel-tracks') ||
        (step.artifactKind === 'ais_heatmap' && step.ui.componentId === 'chart.heatmap')
      )
    )
      throw new Error('展示组件与产物类型不匹配');
    walk(step.input, '', 0);
    seen.add(step.id);
  }
  const expectedArtifacts = definition.steps.flatMap((step) =>
    step.artifactKind ? [{ stepId: step.id, kind: step.artifactKind }] : [],
  );
  const requiredDisplays = definition.steps.filter((step) => step.ui).map((step) => step.id);
  if (
    (definition.expectedArtifacts.length &&
      JSON.stringify(definition.expectedArtifacts) !== JSON.stringify(expectedArtifacts)) ||
    (definition.requiredDisplays.length &&
      JSON.stringify(definition.requiredDisplays) !== JSON.stringify(requiredDisplays))
  )
    throw new Error('预期产物与展示必须对应声明步骤');
  return { ...definition, expectedArtifacts, requiredDisplays };
}
