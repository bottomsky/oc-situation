import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncAgentSkillAssets } from './build-skill-assets';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ais-skill-build-'));
  roots.push(root);
  const agent = join(root, 'apps/agent');
  await mkdir(join(agent, 'skills/sample/references'), { recursive: true });
  await mkdir(join(agent, 'dist'), { recursive: true });
  await writeFile(join(agent, 'skills/sample/SKILL.md'), 'skill');
  await writeFile(join(agent, 'skills/sample/references/old.md'), 'old');
  await writeFile(join(agent, 'dist/main.mjs'), 'keep compiled entry');
  return { root, agent };
}
describe('agent skill asset build', () => {
  it('removes deleted references and obsolete skill directories while preserving other outputs', async () => {
    const { root, agent } = await fixture();
    await syncAgentSkillAssets(root);
    await mkdir(join(agent, 'dist/skills/retired'), { recursive: true });
    await writeFile(join(agent, 'dist/skills/retired/SKILL.md'), 'retired');
    await rm(join(agent, 'skills/sample/references/old.md'));
    await writeFile(join(agent, 'skills/sample/references/current.md'), 'current');
    await syncAgentSkillAssets(root);
    await expect(
      readFile(join(agent, 'dist/skills/sample/references/old.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(agent, 'dist/skills/retired/SKILL.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(agent, 'dist/skills/sample/references/current.md'), 'utf8')).toBe(
      'current',
    );
    expect(await readFile(join(agent, 'dist/main.mjs'), 'utf8')).toBe('keep compiled entry');
  });
  it('rejects a redirected skills output before touching its target', async () => {
    const { root, agent } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'ais-skill-external-'));
    roots.push(outside);
    await writeFile(join(outside, 'keep.md'), 'keep');
    await symlink(outside, join(agent, 'dist/skills'), 'junction');
    await expect(syncAgentSkillAssets(root)).rejects.toThrow('boundary');
    expect(await readFile(join(outside, 'keep.md'), 'utf8')).toBe('keep');
  });
});
