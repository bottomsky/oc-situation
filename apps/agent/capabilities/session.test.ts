import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSkillCatalog } from './catalog';
import { SkillSession } from './session';
import type { CapabilityPorts } from './executor';
const roots: string[] = [];
const identity = {
  ownerId: 'a7ecf638-83f6-4bf3-bd3f-1aaf6303b19f',
  taskId: 'c0e9ea90-ac31-4562-a36c-acfdb71b1e32',
  inputRevision: 1,
  generation: 2,
};
const binding = {
  skillId: 'sample',
  version: '1',
  adapterVersion: '1',
  toolIds: ['query'],
  referencePaths: ['references/guide.md'],
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ais-session-'));
  roots.push(root);
  await mkdir(join(root, 'sample/references'), { recursive: true });
  await writeFile(
    join(root, 'sample/SKILL.md'),
    '---\nname: sample\ndescription: Sample\nallowed-tools: query\n---\nBody',
  );
  await writeFile(join(root, 'sample/references/guide.md'), 'Reference');
  const catalog = await loadSkillCatalog({ root, bindings: [binding] });
  let calls = 0;
  const steps: { key: string; name: string; output: unknown }[] = [];
  const ports: CapabilityPorts = {
    active: async () => true,
    reserve: async () => {
      calls++;
      return true;
    },
    saveStep: async (key, name, output) => {
      steps.push({ key, name, output });
      return true;
    },
  };
  return { root, catalog, ports, steps, calls: () => calls };
}
describe('recoverable skill session', () => {
  it('charges activation/reference once and recovers across generations at same revision', async () => {
    const { catalog, ports, steps, calls } = await fixture();
    const session = new SkillSession(catalog, ports, { identity, steps, maxToolCalls: 5 });
    const [a, b] = await Promise.all([session.activate('sample'), session.activate('sample')]);
    expect(a).toEqual(b);
    expect(a.body).toBe('Body');
    expect(await session.readReference('sample', 'references/guide.md')).toBe('Reference');
    expect(await session.readReference('sample', 'references/guide.md')).toBe('Reference');
    expect(calls()).toBe(2);
    const resumed = new SkillSession(catalog, ports, {
      identity: { ...identity, generation: 3 },
      steps,
    });
    expect((await resumed.activate('sample')).body).toBe('Body');
    expect(await resumed.readReference('sample', 'references/guide.md')).toBe('Reference');
    expect(calls()).toBe(2);
  });
  it('requires activation, rejects arbitrary paths without charging and isolates revisions', async () => {
    const { catalog, ports, steps, calls } = await fixture();
    const session = new SkillSession(catalog, ports, { identity, steps });
    await expect(session.readReference('sample', 'references/guide.md')).rejects.toThrow(
      'skill_not_active',
    );
    await session.activate('sample');
    await expect(session.readReference('sample', '../SKILL.md')).rejects.toThrow('reference');
    expect(calls()).toBe(1);
    await new SkillSession(catalog, ports, {
      identity: { ...identity, inputRevision: 2 },
      steps,
    }).activate('sample');
    expect(calls()).toBe(2);
  });
  it('rejects changed content on recovery before charging', async () => {
    const { root, catalog, ports, steps, calls } = await fixture();
    await new SkillSession(catalog, ports, { identity, steps }).activate('sample');
    await writeFile(join(root, 'sample/references/guide.md'), 'Changed');
    const changed = await loadSkillCatalog({ root, bindings: [binding] });
    await expect(
      new SkillSession(changed, ports, { identity, steps }).activate('sample'),
    ).rejects.toThrow('skill_changed');
    expect(calls()).toBe(1);
  });
  it('fences a lost lease before persisting activation', async () => {
    const { catalog, ports, steps } = await fixture();
    let activeCalls = 0;
    ports.active = async () => ++activeCalls === 1;
    await expect(
      new SkillSession(catalog, ports, { identity, steps }).activate('sample'),
    ).rejects.toThrow('fenced');
    expect(steps).toHaveLength(0);
  });
});
