import type { UserRole } from '@ais/contracts';

interface NavigationGroup {
  id: string;
  label: string;
  icon: string;
  links: { path: string; label: string }[];
}

const groups: NavigationGroup[] = [
  {
    id: 'chart',
    label: '海图态势',
    icon: 'i-lucide-anchor',
    links: [{ path: '/', label: '船位海图' }],
  },
  {
    id: 'ais',
    label: 'AIS监控',
    icon: 'i-lucide-radar',
    links: [{ path: '/sources', label: '数据来源' }],
  },
  {
    id: 'analysis',
    label: '智能研判',
    icon: 'i-lucide-shield-check',
    links: [
      { path: '/topics', label: '分析专题' },
      { path: '/intelligence', label: '情报公告' },
    ],
  },
  {
    id: 'tasks',
    label: '任务管理',
    icon: 'i-lucide-clipboard-list',
    links: [
      { path: '/jobs', label: '采集任务' },
      { path: '/runs', label: '运行记录' },
    ],
  },
  {
    id: 'data',
    label: '数据分析',
    icon: 'i-lucide-chart-no-axes-combined',
    links: [
      { path: '/quality', label: '清洗质量' },
      { path: '/replays', label: '归档重放' },
    ],
  },
  {
    id: 'settings',
    label: '系统设置',
    icon: 'i-lucide-settings',
    links: [{ path: '/users', label: '账号权限' }],
  },
];

export function navigationForRole(role: UserRole | undefined): NavigationGroup[] {
  return groups.filter((group) => group.id !== 'settings' || role === 'admin');
}

export function activeNavigationGroup(path: string, role: UserRole | undefined): string | null {
  return (
    navigationForRole(role).find((group) => group.links.some((link) => link.path === path))?.id ??
    null
  );
}

export function buildChartSearchLocation(input: string, revision: number) {
  const q = input.trim();
  return { path: '/', query: q ? { q, searchRevision: String(revision) } : {} };
}
