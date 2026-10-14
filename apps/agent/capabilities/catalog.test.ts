import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkillCatalog, type SkillToolBinding } from './catalog';

const roots: string[] = [];
const binding: SkillToolBinding = {
  skillId: 'sample',
  version: '1',
  adapterVersion: '1',
  toolIds: ['query'],
  referencePaths: ['references/guide.md'],
};
async function fixture(body = '# Sample\nRead references/guide.md') {
  const root = await mkdtemp(join(tmpdir(), 'ais-skills-'));
  roots.push(root);
  await mkdir(join(root, 'sample/references'), { recursive: true });
  await writeFile(
    join(root, 'sample/SKILL.md'),
    `---\nname: sample\ndescription: >-\n  Trusted sample skill\nallowed-tools: query\n---\n${body}\n`,
  );
  await writeFile(join(root, 'sample/references/guide.md'), 'Reference version one');
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('trusted skill catalog', () => {
  it('parses standard YAML and exposes frozen metadata without body', async () => {
    const root = await fixture();
    const catalog = await loadSkillCatalog({ root, bindings: [binding] });
    expect(catalog.list()).toEqual([
      { skillId: 'sample', version: '1', description: 'Trusted sample skill', toolIds: ['query'] },
    ]);
    expect(Object.isFrozen(catalog.get('sample'))).toBe(true);
    expect(catalog.get('sample').body).toContain('# Sample');
  });
  it('hashes references and adapter version and keeps an immutable loaded snapshot', async () => {
    const root = await fixture();
    const before = await loadSkillCatalog({ root, bindings: [binding] });
    await writeFile(join(root, 'sample/references/guide.md'), 'Reference version two');
    const after = await loadSkillCatalog({ root, bindings: [binding] });
    expect(before.get('sample').references['references/guide.md']).toBe('Reference version one');
    expect(after.get('sample').binding.contentHash).not.toBe(
      before.get('sample').binding.contentHash,
    );
    expect(() => after.assertBinding(before.get('sample').binding)).toThrow('skill_changed');
    const adapter = await loadSkillCatalog({
      root,
      bindings: [{ ...binding, adapterVersion: '2' }],
    });
    expect(adapter.get('sample').binding.contentHash).not.toBe(
      after.get('sample').binding.contentHash,
    );
  });
  it('allows skill declarations to narrow the bound tools', async () => {
    const root = await fixture();
    const catalog = await loadSkillCatalog({
      root,
      bindings: [{ ...binding, toolIds: ['query', 'read'] }],
    });
    expect(catalog.get('sample').metadata.toolIds).toEqual(['query']);
  });
  it('defaults omitted allowed-tools to the trusted binding tools', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'sample/SKILL.md'),
      '---\nname: sample\ndescription: Sample\n---\nBody',
    );
    const catalog = await loadSkillCatalog({
      root,
      bindings: [{ ...binding, toolIds: ['query', 'read'] }],
    });
    expect(catalog.get('sample').metadata.toolIds).toEqual(['query', 'read']);
  });
  it.each(['query shell', 'query query', '""'])(
    'rejects unauthorized, duplicate or empty tool declarations: %s',
    async (tools) => {
      const root = await fixture();
      await writeFile(
        join(root, 'sample/SKILL.md'),
        `---\nname: sample\ndescription: Sample\nallowed-tools: ${tools}\n---\nBody`,
      );
      await expect(loadSkillCatalog({ root, bindings: [binding] })).rejects.toThrow('tool');
    },
  );
  it.each([
    ['name: Sample\ndescription: ok', 'invalid'],
    ['name: other\ndescription: ok', 'directory'],
    ['name: sample\ndescription: ""', 'invalid'],
    ['name: sample\nname: sample\ndescription: ok', 'YAML'],
    ['name: sample\ndescription: ok\nallowed-tools: shell', 'tool'],
  ])('rejects invalid metadata %s', async (metadata, reason) => {
    const root = await fixture();
    await writeFile(join(root, 'sample/SKILL.md'), `---\n${metadata}\n---\nBody`);
    await expect(loadSkillCatalog({ root, bindings: [binding] })).rejects.toThrow(reason);
  });
  it('rejects size limits, duplicate bindings, unapproved references and unsupported files', async () => {
    const root = await fixture();
    await expect(loadSkillCatalog({ root, bindings: [binding], maxFileBytes: 8 })).rejects.toThrow(
      'size',
    );
    await expect(loadSkillCatalog({ root, bindings: [binding, binding] })).rejects.toThrow(
      'duplicate',
    );
    await expect(
      loadSkillCatalog({ root, bindings: [{ ...binding, referencePaths: ['../secret.md'] }] }),
    ).rejects.toThrow('reference');
    await writeFile(join(root, 'sample/run.js'), 'throw 1');
    await expect(loadSkillCatalog({ root, bindings: [binding] })).rejects.toThrow('unsupported');
  });
  it('rejects a real-path escape through a directory symlink', async () => {
    const root = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'ais-outside-'));
    roots.push(outside);
    await rm(join(root, 'sample/references'), { recursive: true });
    await writeFile(join(outside, 'guide.md'), 'outside');
    await symlink(outside, join(root, 'sample/references'), 'junction');
    await expect(loadSkillCatalog({ root, bindings: [binding] })).rejects.toThrow('boundary');
  });
});
