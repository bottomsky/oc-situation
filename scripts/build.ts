import { build } from 'esbuild';
import { readFile, mkdir, cp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { buildPlan, extraBuildEntries } from './build-plan';
import { syncAgentSkillAssets } from './build-skill-assets';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const external = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter(
  (name) => !name.startsWith('@ais/'),
);
const selectedIndex = process.argv.indexOf('--workspace');
const selected = selectedIndex >= 0 ? process.argv[selectedIndex + 1] : undefined;
const names = selected
  ? [selected]
  : [
      'contracts',
      'domain',
      'source-adapters',
      'infrastructure',
      'api',
      'collector',
      'crawler',
      'processor',
      'writer',
      'archiver',
      'intelligence',
      'topics',
      'agent',
    ];
for (const name of names) {
  const plan = buildPlan(name);
  const group = ['contracts', 'domain', 'source-adapters', 'infrastructure'].includes(name)
    ? 'packages'
    : 'apps';
  const directory = join(root, group, name);
  const outfile = join(directory, plan.output);
  await build({
    entryPoints: [join(directory, plan.entry!)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    sourcemap: true,
    external: [...external, '@earendil-works/pi-agent-core', '@earendil-works/pi-ai', 'typebox'],
    tsconfig: join(root, 'tsconfig.base.json'),
    define: name === 'agent' ? { __AGENT_SKILLS_BUNDLED__: 'true' } : {},
    logLevel: 'warning',
  });
  if (plan.migrations)
    await cp(join(root, 'packages/infrastructure/migrations'), join(directory, 'dist/migrations'), {
      recursive: true,
    });
  for (const entry of extraBuildEntries(name))
    await build({
      entryPoints: [join(directory, entry.entry)],
      outfile: join(directory, entry.output),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      sourcemap: true,
      external,
      tsconfig: join(root, 'tsconfig.base.json'),
      logLevel: 'warning',
    });
  if (name === 'intelligence')
    await cp(join(directory, 'fixtures'), join(directory, 'dist/fixtures'), { recursive: true });
  if (name === 'agent') {
    await syncAgentSkillAssets(root);
    await build({
      entryPoints: [join(directory, 'capabilities/check-skills.ts')],
      outfile: join(directory, 'dist/check-skills.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      external,
      tsconfig: join(root, 'tsconfig.base.json'),
      define: { __AGENT_SKILLS_BUNDLED__: 'true' },
      logLevel: 'warning',
    });
  }
  console.log(`构建 ${group}/${name}/${plan.output}`);
}
if (!selected) {
  await mkdir(join(root, 'dist'), { recursive: true });
  await build({
    entryPoints: [join(root, 'infra/init.ts')],
    outfile: join(root, 'dist/init.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external,
    tsconfig: join(root, 'tsconfig.base.json'),
  });
  await cp(join(root, 'packages/infrastructure/migrations'), join(root, 'dist/migrations'), {
    recursive: true,
  });
  await writeFile(
    join(root, 'dist/build.json'),
    JSON.stringify(
      { runtime: 'node24', builtAt: new Date().toISOString(), workspaces: names },
      null,
      2,
    ),
  );
  if (!process.argv.includes('--backend-only')) {
    await new Promise<void>((ok, bad) => {
      const proc = spawn(
        process.execPath,
        [join(root, 'node_modules/nuxt/bin/nuxt.mjs'), 'build'],
        { cwd: join(root, 'apps/web'), stdio: 'inherit', shell: false },
      );
      proc.once('error', bad);
      proc.once('exit', (code) =>
        code === 0 ? ok() : bad(new Error(`Nuxt build exited ${code}`)),
      );
    });
  }
}
