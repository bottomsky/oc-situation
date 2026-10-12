import { Inject, Injectable, UnauthorizedException, HttpException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { Infrastructure } from '@ais/infrastructure';
import type { UserRole } from '@ais/contracts';
import { INFRA, isoValue } from '../common';
import { csrfToken, hashToken } from './security';
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;
export const hashPassword = (value: string) => argon2.hash(value, ARGON2_OPTIONS);
export interface SessionUser {
  id: string;
  username: string;
  role: UserRole;
}
@Injectable()
export class AuthService {
  private readonly dummyHash = hashPassword(randomBytes(32).toString('hex'));
  constructor(@Inject(INFRA) private readonly infra: Infrastructure) {}
  async login(username: string, password: string, ip: string) {
    const client = await this.infra.pool.connect();
    try {
      await client.query('BEGIN');
      const ipKey = hashToken(ip);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`login:${ipKey}`]);
      const attempts = await client.query(
        "SELECT count(*)::int AS count FROM audit WHERE action='login_attempt' AND resource_id=$1 AND created_at>now()-interval '5 minutes'",
        [ipKey],
      );
      if (attempts.rows[0].count >= 20) throw new HttpException('Too many login attempts', 429);
      await client.query(
        "INSERT INTO audit(id,action,resource_type,resource_id) VALUES($1,'login_attempt','authentication',$2)",
        [randomUUID(), ipKey],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const result = await this.infra.pool.query(
      'SELECT id,username,password_hash,role,disabled FROM users WHERE username=$1',
      [username],
    );
    const record = result.rows[0];
    const valid = await argon2.verify(record?.password_hash ?? (await this.dummyHash), password);
    if (!record || record.disabled || !valid)
      throw new UnauthorizedException('Invalid username or password');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    await this.infra.pool.query('INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,$3)', [
      hashToken(token),
      record.id,
      expiresAt,
    ]);
    return {
      token,
      user: { id: record.id, username: record.username, role: record.role } as SessionUser,
      csrfToken: csrfToken(token),
      expiresAt,
    };
  }
  async session(token: string | undefined) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new UnauthorizedException('Session required');
    const result = await this.infra.pool.query(
      'SELECT u.id,u.username,u.role,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.expires_at>now() AND NOT u.disabled',
      [hashToken(token)],
    );
    const row = result.rows[0];
    if (!row) throw new UnauthorizedException('Session required');
    return {
      user: { id: row.id, username: row.username, role: row.role } as SessionUser,
      csrfToken: csrfToken(token),
      expiresAt: isoValue(row.expires_at),
    };
  }
  async logout(token: string) {
    await this.infra.pool.query('DELETE FROM sessions WHERE id=$1', [hashToken(token)]);
  }
}
export async function bootstrapAdmin(
  infra: Infrastructure,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { ADMIN_USERNAME: username, ADMIN_PASSWORD: password } = env;
  const minimumPasswordLength = infra.config.production ? 12 : 8;
  if (!username || !password || password.length < minimumPasswordLength)
    throw new Error(
      `Explicit ADMIN_USERNAME and ADMIN_PASSWORD (${minimumPasswordLength}+ chars) required`,
    );
  await infra.pool.query(
    "INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,'admin') ON CONFLICT(username) DO NOTHING",
    [randomUUID(), username, await hashPassword(password)],
  );
}
