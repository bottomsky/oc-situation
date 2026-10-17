import { describe, expect, it } from 'vitest';
import {
  activeNavigationGroup,
  buildChartSearchLocation,
  navigationForRole,
} from './app/utils/navigation';

describe('top navigation permissions and route grouping', () => {
  it('keeps all destinations available to administrators', () => {
    const groups = navigationForRole('admin');
    expect(groups.map((group) => group.label)).toEqual([
      '海图态势',
      'AIS监控',
      '智能研判',
      '任务管理',
      '数据分析',
      '系统设置',
    ]);
    expect(groups.flatMap((group) => group.links.map((link) => link.path)).sort()).toEqual(
      [
        '/',
        '/topics',
        '/intelligence',
        '/skills',
        '/sources',
        '/jobs',
        '/runs',
        '/quality',
        '/replays',
        '/users',
      ].sort(),
    );
  });

  it.each(['viewer', 'operator', undefined] as const)(
    'hides administration destinations for %s',
    (role) => {
      expect(navigationForRole(role)).toHaveLength(5);
      expect(navigationForRole(role).flatMap((group) => group.links)).toContainEqual(
        expect.objectContaining({ path: '/skills', label: '我的技能' }),
      );
      expect(navigationForRole(role).flatMap((group) => group.links)).not.toContainEqual(
        expect.objectContaining({ path: '/users' }),
      );
    },
  );

  it.each([
    ['/', 'chart'],
    ['/sources', 'ais'],
    ['/topics', 'analysis'],
    ['/intelligence', 'analysis'],
    ['/skills', 'analysis'],
    ['/jobs', 'tasks'],
    ['/runs', 'tasks'],
    ['/quality', 'data'],
    ['/replays', 'data'],
    ['/users', 'settings'],
  ])('marks %s as part of its original module', (path, group) => {
    expect(activeNavigationGroup(path, 'admin')).toBe(group);
  });

  it('does not highlight inaccessible or unmatched routes', () => {
    expect(activeNavigationGroup('/users', 'viewer')).toBeNull();
    expect(activeNavigationGroup('/login', 'admin')).toBeNull();
    expect(activeNavigationGroup('/jobs-other', 'admin')).toBeNull();
  });
});

describe('global ship search route', () => {
  it('trims names and preserves MMSI, IMO and special characters as query values', () => {
    expect(buildChartSearchLocation('  中远 & 413518000 / IMO  1234567  ', 7)).toEqual({
      path: '/',
      query: { q: '中远 & 413518000 / IMO  1234567', searchRevision: '7' },
    });
  });

  it('gives repeated searches a different route to trigger a new request', () => {
    expect(buildChartSearchLocation('413518000', 8)).not.toEqual(
      buildChartSearchLocation('413518000', 9),
    );
  });

  it('clears the chart search when input is blank', () => {
    expect(buildChartSearchLocation(' \n\t ', 10)).toEqual({ path: '/', query: {} });
  });
});
