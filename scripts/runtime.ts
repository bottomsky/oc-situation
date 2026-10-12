import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/** Resolve an executable, never a PowerShell/CMD shim. Child processes use shell:false. */
export function resolveBun(
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    exists?: (path: string) => boolean;
  } = {},
): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  if (env.BUN_EXECUTABLE) {
    if (!exists(env.BUN_EXECUTABLE))
      throw new Error('BUN_EXECUTABLE points to a missing executable');
    return env.BUN_EXECUTABLE;
  }
  const path = platform === 'win32' ? win32 : posix;
  const directories = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':');
  for (const directory of directories.filter(Boolean)) {
    for (const candidate of platform === 'win32'
      ? [
          path.join(directory, 'bun.exe'),
          path.join(directory, 'node_modules', 'bun', 'bin', 'bun.exe'),
        ]
      : [path.join(directory, 'bun')]) {
      if (exists(candidate)) return candidate;
    }
  }
  throw new Error('Bun executable not found. Set BUN_EXECUTABLE to the actual binary path.');
}
