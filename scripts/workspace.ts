import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { resolveBun } from './runtime';

type Manifest = {
  name: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
type Workspace = { directory: string; manifest: Manifest };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2];
const forwarded = process.argv.slice(3);
const bun = () => resolveBun();

function run(executable: string, args: string[], cwd = root, environment: NodeJS.ProcessEnv = {}) {
  return new Promise<void>((resolveRun, reject) => {
    console.log(`执行 ${executable} ${args.join(' ')} (${cwd})`);
    const child = spawn(executable, args, {
      cwd,
      stdio: 'inherit',
      shell: false,
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: join(root, 'tsconfig.base.json'),
        PLAYWRIGHT_BROWSERS_PATH: join(root, '.data/playwright'),
        ...environment,
      },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`命令执行失败：退出码 ${code ?? signal}`));
    });
    const interrupt = () => child.kill('SIGINT');
    process.once('SIGINT', interrupt);
    child.once('exit', () => process.removeListener('SIGINT', interrupt));
  });
}

function discover(): Workspace[] {
  const entries: Workspace[] = [];
  for (const group of ['packages', 'apps']) {
    const directory = join(root, group);
    if (!existsSync(directory)) continue;
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const workspaceDirectory = join(directory, child.name);
      const manifestPath = join(workspaceDirectory, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
      if (!manifest.name) throw new Error(`${manifestPath} 缺少包名`);
      entries.push({ directory: workspaceDirectory, manifest });
    }
  }
  const names = new Map(entries.map((entry) => [entry.manifest.name, entry]));
  if (names.size !== entries.length) throw new Error('工作区中存在重复包名');
  const ordered: Workspace[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(entry: Workspace) {
    const name = entry.manifest.name;
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`工作区依赖存在循环：${name}`);
    visiting.add(name);
    for (const dependency of Object.keys({
      ...entry.manifest.dependencies,
      ...entry.manifest.devDependencies,
    })) {
      const target = names.get(dependency);
      if (target) visit(target);
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(entry);
  }
  entries.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name)).forEach(visit);
  return ordered;
}

async function workspaceTask(task: string, selected?: string) {
  const workspaces = discover().filter((entry) => !selected || entry.manifest.name === selected);
  if (!workspaces.length) throw new Error(`未找到工作区${selected ? ` ${selected}` : ''}`);
  if (task === 'typecheck') {
    await run(process.execPath, [
      join(root, 'node_modules/typescript/bin/tsc'),
      '--project',
      'tsconfig.json',
      '--noEmit',
    ]);
  }
  for (const workspace of workspaces) {
    if (workspace.manifest.scripts?.[task]) {
      await run(
        bun(),
        ['--no-env-file', 'run', task, ...forwarded.filter((value) => value !== selected)],
        workspace.directory,
      );
    } else if (task === 'typecheck' && existsSync(join(workspace.directory, 'tsconfig.json'))) {
      if (workspace.manifest.name === '@ais/web')
        throw new Error('@ais/web 必须声明 Nuxt typecheck 脚本');
      await run(
        process.execPath,
        [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--project', 'tsconfig.json'],
        workspace.directory,
      );
    } else {
      throw new Error(`${workspace.manifest.name} 缺少 ${task} 脚本`);
    }
  }
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) !== 24)
    throw new Error('请使用 Node.js 24 执行工作区命令');
  switch (command) {
    case 'lint': {
      const paths = [
        'apps',
        'packages',
        'scripts',
        'tests',
        'eslint.config.mjs',
        'vitest.config.ts',
        'playwright.config.ts',
      ].filter((path) => existsSync(join(root, path)));
      await run(process.execPath, [
        join(root, 'node_modules/eslint/bin/eslint.js'),
        ...paths,
        '--max-warnings',
        '0',
        ...forwarded,
      ]);
      break;
    }
    case 'typecheck':
      await workspaceTask(command);
      break;
    case 'build':
      await run(process.execPath, [
        '--import',
        'tsx',
        join(root, 'scripts/build.ts'),
        ...forwarded,
      ]);
      break;
    case 'dev':
      await workspaceTask('dev', forwarded[0]);
      break;
    case 'test':
    case 'test:integration':
      await run(
        process.execPath,
        [
          join(root, 'node_modules/vitest/vitest.mjs'),
          'run',
          '--config',
          'vitest.config.ts',
          ...forwarded,
        ],
        root,
        { AIS_TEST_SCOPE: command === 'test:integration' ? 'integration' : 'unit' },
      );
      break;
    case 'test:e2e':
      if (!existsSync(join(root, 'playwright.config.ts')))
        throw new Error('缺少 playwright.config.ts；端到端测试尚未接入');
      await run(process.execPath, [
        join(root, 'node_modules/@playwright/test/cli.js'),
        'test',
        ...forwarded,
      ]);
      break;
    case 'infra:up': {
      const compose = ['infra/compose.yaml', 'infra/compose.yml', 'infra/docker-compose.yml'].find(
        (path) => existsSync(join(root, path)),
      );
      if (!compose) throw new Error('缺少基础设施 Compose 文件');
      await run('docker', ['compose', '-f', compose, 'up', '-d', ...forwarded]);
      break;
    }
    case 'migrate':
    case 'seed':
    case 'demo':
    case 'bench': {
      const script = join(root, 'scripts', `${command}.ts`);
      if (existsSync(script)) {
        await run(process.execPath, ['--import', 'tsx', script, ...forwarded]);
      } else {
        const owners = discover().filter((entry) => entry.manifest.scripts?.[command]);
        if (owners.length !== 1)
          throw new Error(
            `${command} 需要一个明确入口：scripts/${command}.ts 或一个子包的同名脚本（当前找到 ${owners.length} 个）`,
          );
        const owner = owners[0]!;
        await run(bun(), ['--no-env-file', 'run', command, ...forwarded], owner.directory);
      }
      break;
    }
    case 'intelligence:sources':
      await run(process.execPath, [
        '--import',
        'tsx',
        join(root, 'scripts', 'intelligence-sources.ts'),
        ...forwarded,
      ]);
      break;
    case 'api:generate':
    case 'build:smoke':
      await run(process.execPath, [
        '--import',
        'tsx',
        join(root, 'scripts', command === 'api:generate' ? 'generate-api.ts' : 'build-smoke.ts'),
      ]);
      break;
    default:
      throw new Error(`未知工作区命令：${command ?? '(空)'}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
