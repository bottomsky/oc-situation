import { expect, it } from 'vitest';
import { trustedProxies } from './proxy';
it('never trusts arbitrary forwarding headers in development or an unspecified production proxy', () => {
  expect(trustedProxies(false, '127.0.0.1')).toBe(false);
  expect(trustedProxies(true)).toBe(false);
  expect(trustedProxies(true, '172.30.0.2')).toEqual(['172.30.0.2']);
  expect(() => trustedProxies(true, '0.0.0.0/0')).toThrow();
  expect(() => trustedProxies(true, 'true')).toThrow();
});
