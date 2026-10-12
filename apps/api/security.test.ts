import { describe, expect, it } from 'vitest';
import { permits, csrfToken, assertWriteSecurity } from './src/auth/security';
import { bounds, parseMapQuery } from './src/map/query';
describe('authorization and write security', () => {
  it('allows readers but reserves task controls and admin edits', () => {
    expect(permits('viewer', 'viewer')).toBe(true);
    expect(permits('viewer', 'operator')).toBe(false);
    expect(permits('operator', 'admin')).toBe(false);
    expect(permits('admin', 'operator')).toBe(true);
  });
  it('requires allowed origin and session bound CSRF on authenticated writes', () => {
    const token = 'unpredictable-session-token';
    expect(csrfToken(token)).toHaveLength(64);
    expect(() =>
      assertWriteSecurity('https://evil.test', ['http://localhost:13001'], csrfToken(token), token),
    ).toThrow();
    expect(() =>
      assertWriteSecurity('http://localhost:13001', ['http://localhost:13001'], 'wrong', token),
    ).toThrow();
    expect(() =>
      assertWriteSecurity(undefined, ['http://localhost:13001'], csrfToken(token), token),
    ).toThrow();
    expect(() =>
      assertWriteSecurity(
        'http://localhost:13001',
        ['http://localhost:13001'],
        csrfToken(token),
        token,
      ),
    ).not.toThrow();
  });
});
describe('bounded map query', () => {
  it('splits date line bounds without losing eastern or western points', () => {
    expect(bounds([170, -20, -170, 20])).toEqual([
      [170, -20, 180, 20],
      [-180, -20, -170, 20],
    ]);
    expect(bounds([-10, -20, 10, 20])).toEqual([[-10, -20, 10, 20]]);
  });
  it('rejects invalid inputs and defaults to fresh 24h observations', () => {
    expect(parseMapQuery({ bbox: '170,-20,-170,20', zoom: '9' }).hours).toBe(24);
    expect(() => parseMapQuery({ bbox: '0,90,0,-90', zoom: '9' })).toThrow();
    expect(() => parseMapQuery({ bbox: '0,0,1,1', hours: '721', zoom: '9' })).toThrow();
    expect(() => parseMapQuery({ bbox: '0,0,1,1;DROP TABLE vessels', zoom: '9' })).toThrow();
  });
});
