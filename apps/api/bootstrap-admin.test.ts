import argon2 from 'argon2';
import type { Infrastructure } from '@ais/infrastructure';
import { describe, expect, it, vi } from 'vitest';
import { bootstrapAdmin } from './src/auth/service';

function setup(production: boolean) {
  const query = vi.fn(async (_sql: string, _values: string[]) => ({ rows: [] }));
  const infra = { config: { production }, pool: { query } } as unknown as Infrastructure;
  return { infra, query };
}

describe('explicit bootstrap administrator credentials', () => {
  it('accepts an eight-character development password and stores an Argon2id hash', async () => {
    const { infra, query } = setup(false);
    await bootstrapAdmin(infra, {
      NODE_ENV: 'production',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'admin123',
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toBe(
      "INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,'admin') ON CONFLICT(username) DO NOTHING",
    );
    expect(values[0]).toMatch(/^[\da-f-]{36}$/);
    expect(values[1]).toBe('admin');
    expect(values[2]).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(values[2]!, 'admin123')).toBe(true);
  });

  it('rejects an eight-character production password before writing an account', async () => {
    const { infra, query } = setup(true);
    await expect(
      bootstrapAdmin(infra, {
        NODE_ENV: 'development',
        ADMIN_USERNAME: 'admin',
        ADMIN_PASSWORD: 'admin123',
      }),
    ).rejects.toThrow('Explicit ADMIN_USERNAME and ADMIN_PASSWORD (12+ chars) required');
    expect(query).not.toHaveBeenCalled();
  });

  it('accepts a twelve-character production password', async () => {
    const { infra, query } = setup(true);
    await bootstrapAdmin(infra, { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin1234567' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(await argon2.verify(query.mock.calls[0]![1][2]!, 'admin1234567')).toBe(true);
  });

  it('rejects development passwords shorter than eight characters', async () => {
    const { infra, query } = setup(false);
    await expect(
      bootstrapAdmin(infra, { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin12' }),
    ).rejects.toThrow('Explicit ADMIN_USERNAME and ADMIN_PASSWORD (8+ chars) required');
    expect(query).not.toHaveBeenCalled();
  });

  it('requires an explicit development username', async () => {
    const { infra, query } = setup(false);
    await expect(bootstrapAdmin(infra, { ADMIN_PASSWORD: 'admin123' })).rejects.toThrow(
      'Explicit ADMIN_USERNAME and ADMIN_PASSWORD (8+ chars) required',
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('requires an explicit development password', async () => {
    const { infra, query } = setup(false);
    await expect(bootstrapAdmin(infra, { ADMIN_USERNAME: 'admin' })).rejects.toThrow(
      'Explicit ADMIN_USERNAME and ADMIN_PASSWORD (8+ chars) required',
    );
    expect(query).not.toHaveBeenCalled();
  });
});
