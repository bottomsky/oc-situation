import { describe, expect, it } from 'vitest';
import { validateDynamicSkillDefinition } from '../domain/dynamic-skills';

const toolCatalog = [
  { id: 'query_vessels', artifactKinds: ['vessel_list'], allowedPhases: ['skill'] },
  { id: 'query_vessel_tracks', artifactKinds: ['vessel_tracks'], allowedPhases: ['skill'] },
];
const definition = {
  schemaVersion: 1,
  name: 'cargo-tracks',
  description: '查询货船并展示航线',
  body: '先查询任务范围中的货船，再根据结果展示历史航线。',
  toolIds: ['query_vessels', 'query_vessel_tracks'],
  steps: [
    {
      id: 'cargo',
      toolId: 'query_vessels',
      input: { selection: { $ref: 'input.selection' } },
      artifactKind: 'vessel_list',
    },
    {
      id: 'tracks',
      toolId: 'query_vessel_tracks',
      input: { vessels: { $ref: 'steps.cargo' } },
      artifactKind: 'vessel_tracks',
      ui: { componentId: 'chart.vessel-tracks', action: 'show' },
    },
  ],
};

describe('declarative dynamic skill validation', () => {
  it('validates a bounded composition using earlier local outputs', () => {
    expect(validateDynamicSkillDefinition(definition, toolCatalog).steps).toHaveLength(2);
  });
  it('rejects forward references and prototype traversal', () => {
    for (const path of ['steps.tracks', 'input.selection.__proto__', 'steps.cargo.constructor'])
      expect(() =>
        validateDynamicSkillDefinition(
          { ...definition, steps: [{ ...definition.steps[0], input: { value: { $ref: path } } }] },
          toolCatalog,
        ),
      ).toThrow();
  });
  it('rejects unknown tools, recursive management and undeclared tool grants', () => {
    for (const toolId of ['shell', 'skills.publish', 'unknown'])
      expect(() =>
        validateDynamicSkillDefinition(
          { ...definition, toolIds: [toolId], steps: [{ id: 'one', toolId, input: {} }] },
          toolCatalog,
        ),
      ).toThrow();
    expect(() =>
      validateDynamicSkillDefinition({ ...definition, toolIds: ['query_vessels'] }, toolCatalog),
    ).toThrow();
  });
  it('rejects literal task coordinates and credentials in reusable definitions', () => {
    for (const input of [{ bbox: [1, 2, 3, 4] }, { apiKey: 'secret' }, { mmsis: ['123456789'] }])
      expect(() =>
        validateDynamicSkillDefinition(
          { ...definition, steps: [{ ...definition.steps[0], input }] },
          toolCatalog,
        ),
      ).toThrow();
  });
  it('rejects input templates that the host registry cannot execute', () => {
    for (const input of [
      { command: 'run' },
      { selection: { $ref: 'steps.cargo' } },
      { vessels: { $ref: 'input.selection' } },
    ])
      expect(() =>
        validateDynamicSkillDefinition(
          { ...definition, steps: [{ ...definition.steps[0], input }] },
          toolCatalog,
        ),
      ).toThrow();
  });
  it('preserves registered reusable vessel-class semantics without accepting arbitrary filters', () => {
    expect(
      validateDynamicSkillDefinition(
        {
          ...definition,
          steps: [
            {
              ...definition.steps[0],
              input: { selection: { $ref: 'input.selection' }, vesselClass: 'cargo' },
            },
          ],
        },
        toolCatalog,
      ).steps[0]?.input.vesselClass,
    ).toBe('cargo');
    for (const vesselClass of ['any', 70, { command: 'shell' }])
      expect(() =>
        validateDynamicSkillDefinition(
          { ...definition, steps: [{ ...definition.steps[0], input: { vesselClass } }] },
          toolCatalog,
        ),
      ).toThrow();
  });
  it('accepts distinct registered vessel classes as a reusable union', () => {
    const vesselClasses = ['cargo', 'tanker', 'passenger', 'fishing'];
    const result = validateDynamicSkillDefinition(
      {
        ...definition,
        steps: [
          {
            ...definition.steps[0],
            input: { selection: { $ref: 'input.selection' }, vesselClasses },
          },
        ],
      },
      toolCatalog,
    );
    expect(result.steps[0]?.input.vesselClasses).toEqual(vesselClasses);
  });
  it('rejects invalid class unions, mixed class fields and grants on another tool', () => {
    for (const input of [
      { vesselClasses: [] },
      { vesselClasses: ['cargo', 'cargo'] },
      { vesselClasses: ['cargo', 'tanker', 'passenger', 'fishing', 'cargo'] },
      { vesselClasses: ['unknown'] },
      { vesselClasses: [70] },
      { vesselClasses: { $ref: 'input.selection' } },
      { vesselClass: 'cargo', vesselClasses: ['tanker'] },
    ])
      expect(() =>
        validateDynamicSkillDefinition(
          { ...definition, steps: [{ ...definition.steps[0], input }] },
          toolCatalog,
        ),
      ).toThrow();
    for (const input of [{ vesselClass: 'cargo' }, { vesselClasses: ['cargo', 'tanker'] }])
      expect(() =>
        validateDynamicSkillDefinition(
          { ...definition, steps: [{ ...definition.steps[1], input }] },
          toolCatalog,
        ),
      ).toThrow();
  });
});
