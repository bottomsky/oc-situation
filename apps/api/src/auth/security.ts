import { createHash, timingSafeEqual } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
export function permits(role: string, minimum: string): boolean {
  const rank: Record<string, number> = { viewer: 0, operator: 1, admin: 2 };
  return role in rank && minimum in rank && rank[role]! >= rank[minimum]!;
}
export const csrfToken = (token: string): string => hashToken(`csrf:${token}`);
export function assertWriteSecurity(
  origin: string | undefined,
  origins: string[],
  header?: string,
  token?: string,
): void {
  if (!origin || !origins.includes(origin)) throw new ForbiddenException('Untrusted origin');
  if (token) {
    const expected = Buffer.from(csrfToken(token));
    const actual = Buffer.from(header ?? '');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      throw new ForbiddenException('Invalid CSRF token');
  }
}
