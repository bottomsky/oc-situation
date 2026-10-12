import { describe, expect, it } from 'vitest';
import { resolveBun } from './runtime';

describe('Bun executable resolution', () => {
  it('prefers an explicit executable without a shell', () => {
    expect(
      resolveBun({
        platform: 'win32',
        env: { BUN_EXECUTABLE: 'C:\\tools\\bun.exe' },
        exists: () => true,
      }),
    ).toBe('C:\\tools\\bun.exe');
  });
  it('finds Bun behind the Node package shim on Windows', () => {
    const actual = 'D:\\nodejs\\node_modules\\bun\\bin\\bun.exe';
    expect(
      resolveBun({
        platform: 'win32',
        env: { PATH: 'D:\\nodejs;C:\\Windows' },
        exists: (path) => path === actual,
      }),
    ).toBe(actual);
  });
  it('fails explicitly for an invalid override', () => {
    expect(() => resolveBun({ env: { BUN_EXECUTABLE: '/missing' }, exists: () => false })).toThrow(
      'BUN_EXECUTABLE',
    );
  });
  it('resolves Unix PATH binaries', () => {
    expect(
      resolveBun({
        platform: 'linux',
        env: { PATH: '/bin:/usr/local/bin' },
        exists: (path) => path === '/usr/local/bin/bun',
      }),
    ).toBe('/usr/local/bin/bun');
  });
});
