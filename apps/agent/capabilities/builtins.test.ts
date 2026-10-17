import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SKILL_BINDINGS,
  buildCapabilityDirectory,
  loadBuiltinSkillCatalog,
} from './builtins';

describe('bundled trusted skills', () => {
  it('discovers seven skill packages with runtime tool bindings and legacy directory metadata', async () => {
    const catalog = await loadBuiltinSkillCatalog();
    expect(
      catalog
        .list()
        .map((skill) => skill.skillId)
        .sort(),
    ).toEqual([
      'ais-heatmap',
      'intelligence-search',
      'map-camera',
      'ui-control',
      'vessel-highlight',
      'vessel-query',
      'vessel-tracks',
    ]);
    for (const binding of BUILTIN_SKILL_BINDINGS) {
      expect(catalog.get(binding.skillId).metadata.toolIds).toEqual(binding.toolIds);
      for (const reference of binding.referencePaths)
        expect(catalog.get(binding.skillId).body).toContain(reference);
    }
    expect(buildCapabilityDirectory(catalog).find((capability) => capability.legacy)?.id).toBe(
      'region-analysis',
    );
    expect(
      buildCapabilityDirectory(catalog).find((capability) => capability.id === 'ais-heatmap')
        ?.description,
    ).toBe(catalog.get('ais-heatmap').metadata.description);
  });
  it('provides typed routing, input, execution and availability metadata', async () => {
    const directory = buildCapabilityDirectory(await loadBuiltinSkillCatalog());
    expect(directory.find((entry) => entry.id === 'ais-heatmap')).toMatchObject({
      intents: ['ais_heatmap'],
      requiredInputs: { ais_heatmap: ['region', 'time'] },
      executionMode: 'local',
      available: true,
    });
    expect(directory.find((entry) => entry.id === 'vessel-query')).toMatchObject({
      intents: ['vessel_list', 'vessel_detail'],
      requiredInputs: { vessel_list: ['region'], vessel_detail: ['vessels'] },
      executionMode: 'local',
      available: true,
    });
    expect(directory.find((entry) => entry.id === 'intelligence-search')).toMatchObject({
      executionMode: 'model',
      requiredInputs: { intelligence_search: ['topic'] },
      available: true,
    });
    expect(directory.find((entry) => entry.id === 'region-analysis')).toMatchObject({
      intents: ['analysis'],
      executionMode: 'legacy',
      available: true,
    });
  });
});
