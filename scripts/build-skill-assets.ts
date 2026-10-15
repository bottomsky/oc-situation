import { cp, lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

async function assertExactDirectory(path: string): Promise<void> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory() || (await realpath(path)) !== path) {
    throw new Error('Agent skill build path boundary violation');
  }
}

/** Replace only the checked agent skill output so removed source resources cannot survive a build. */
export async function syncAgentSkillAssets(workspaceRoot: string): Promise<void> {
  const root = await realpath(resolve(workspaceRoot));
  const agent = join(root, 'apps', 'agent');
  const source = join(agent, 'skills');
  const dist = join(agent, 'dist');
  const target = join(dist, 'skills');
  await assertExactDirectory(agent);
  await assertExactDirectory(source);
  await mkdir(dist, { recursive: true });
  await assertExactDirectory(dist);
  try {
    await lstat(target);
    await assertExactDirectory(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // All ancestors and the existing deletion target have been resolved and checked above.
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
}
