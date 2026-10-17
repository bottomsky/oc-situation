import { test, expect, type Page, type Route } from '@playwright/test';
import { chartFixture } from './fixtures/chart-fixture';
import { tracksResult } from './fixtures/vessel-tracks-fixture';
import { dynamicSkillUiFixture } from './fixtures/dynamic-skill-ui-fixture';

const at = '2026-10-17T00:00:00Z';
const definition = {
  schemaVersion: 1,
  name: 'cargo-workflow',
  description: '货船查询与航线热图',
  body: '按当前任务输入查询货船，形成清单、航线和热图。',
  references: {},
  requiredInputs: ['region'],
  toolIds: ['query_vessels'],
  steps: [
    {
      id: 'cargo',
      toolId: 'query_vessels',
      input: { selection: { $ref: 'input.selection' }, vesselClass: 'cargo' },
      artifactKind: 'vessel_list',
    },
  ],
  expectedArtifacts: [],
  requiredDisplays: [],
};
const binding = {
  skillId: 'private-cargo',
  version: '1',
  contentHash: 'a'.repeat(64),
  adapterVersion: 'declarative-v1',
};
const version = (id = '1') => ({
  ownerId: 'fixture-user',
  binding: { ...binding, version: id },
  definition,
  source: 'agent',
  createdAt: at,
  revokedAt: null,
});

async function skillsFixture(
  page: Page,
  options: { role?: string; enabled?: boolean; failure?: 'lost' | 'conflict' } = {},
) {
  await chartFixture(page, { role: options.role ?? 'operator' });
  let revision = 2;
  let active = '1';
  let enabled = true;
  let failed = false;
  const writes: Record<string, unknown>[] = [];
  const summary = () => ({
    skillId: binding.skillId,
    name: definition.name,
    description: definition.description,
    toolIds: definition.toolIds,
    enabled,
    currentVersion: active,
    source: 'agent',
    createdAt: at,
    updatedAt: at,
  });
  await page.route('**/api/v1/agent/config', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        uiEnabled: false,
        dynamicSkillsEnabled: options.enabled ?? true,
        defaultHistoryHours: 24,
        maxHistoryHours: 168,
        maxModelCalls: 12,
        maxToolCalls: 24,
      },
    }),
  );
  await page.route('**/api/v1/agent/skills**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'GET') {
      await route.fulfill({
        json: path.endsWith('/skills')
          ? { catalogRevision: revision, items: [summary()] }
          : { catalogRevision: revision, skill: summary(), versions: [version('1'), version('2')] },
      });
      return;
    }
    const body = route.request().postDataJSON();
    writes.push(body);
    if (!failed && options.failure) {
      failed = true;
      if (options.failure === 'lost') await route.abort('failed');
      else {
        revision++;
        await route.fulfill({ status: 409, json: { error: { message: '目录已改变' } } });
      }
      return;
    }
    if (path.endsWith('/state')) enabled = body.enabled;
    if (path.endsWith('/activate')) active = path.split('/').at(-2)!;
    revision++;
    await route.fulfill({
      json: { catalogRevision: revision, skill: summary(), version: version(active) },
    });
  });
  return { writes };
}

test('我的技能处于智能研判导航，viewer只读并在关闭开关时保留历史', async ({ page }) => {
  await skillsFixture(page, { role: 'viewer', enabled: false });
  await page.goto('/skills');
  await expect(page.getByRole('heading', { name: '我的技能', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '展开智能研判导航', exact: true }).click();
  await expect(page.getByRole('link', { name: '我的技能', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '展开智能研判导航', exact: true }).click();
  await page.getByRole('button', { name: /cargo-workflow/ }).click();
  await expect(page.getByLabel('历史版本')).toBeVisible();
  await expect(page.getByRole('button', { name: '新建技能' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '停用技能' })).toHaveCount(0);
  await page.screenshot({
    path: '.data/skills-browser-results/skills-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.data/skills-browser-results/skills-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('发布丢失响应后重试复用操作键，并可启停和切换活动版本', async ({ page }) => {
  const fixture = await skillsFixture(page, { failure: 'lost' });
  await page.goto('/skills');
  await page.getByRole('button', { name: '新建技能', exact: true }).click();
  await page.getByLabel('技能定义 JSON').fill(JSON.stringify(definition));
  await page.getByRole('button', { name: '校验并发布', exact: true }).click();
  await expect(page.getByText('网络连接失败或请求超时，请检查连接后重试')).toBeVisible();
  await page.getByRole('button', { name: '校验并发布', exact: true }).click();
  await expect(page.getByRole('button', { name: '停用技能', exact: true })).toBeVisible();
  expect(fixture.writes[0]?.operationId).toBe(fixture.writes[1]?.operationId);
  await page.getByRole('button', { name: '停用技能', exact: true }).click();
  await expect(page.getByRole('button', { name: '启用技能', exact: true })).toBeVisible();
  await page.getByLabel('历史版本').selectOption('2');
  await page.getByRole('button', { name: '设为活动版本', exact: true }).click();
  await expect(page.getByLabel('历史版本')).toHaveValue('2');
  await expect(page.getByRole('button', { name: '设为活动版本', exact: true })).toHaveCount(0);
});

test('发布目录冲突后刷新并核对新修订可继续发布', async ({ page }) => {
  const fixture = await skillsFixture(page, { failure: 'conflict' });
  await page.goto('/skills');
  await page.getByRole('button', { name: '新建技能', exact: true }).click();
  await page.getByLabel('技能定义 JSON').fill(JSON.stringify(definition));
  await page.getByRole('button', { name: '校验并发布', exact: true }).click();
  await expect(page.getByText('目录已更新，请刷新后核对当前版本再操作。')).toBeVisible();
  await page.getByRole('button', { name: '刷新目录', exact: true }).click();
  await expect(page.getByText('1 项 · 修订 3')).toBeVisible();
  await page.getByRole('button', { name: '校验并发布', exact: true }).click();
  await expect(page.getByRole('button', { name: '停用技能', exact: true })).toBeVisible();
  expect(fixture.writes.map((item) => item.expectedCatalogRevision)).toEqual([2, 3]);
});

test('退出并切换账号后迟到详情不会进入新账号目录', async ({ page }) => {
  await skillsFixture(page);
  let otherOwner = false;
  let held: Route | undefined;
  await page.route('**/api/v1/auth/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/logout')) {
      await route.fulfill({ status: 204 });
      return;
    }
    if (path.endsWith('/login')) otherOwner = true;
    await route.fulfill({
      json: {
        user: {
          id: otherOwner ? 'other-owner' : 'fixture-user',
          username: otherOwner ? '另一账号' : '测试用户',
          role: 'operator',
        },
        csrfToken: 'fixture-csrf',
        expiresAt: '2099-01-01',
      },
    });
  });
  await page.route('**/api/v1/agent/skills**', async (route) => {
    if (otherOwner) {
      await route.fulfill({ json: { catalogRevision: 0, items: [] } });
      return;
    }
    if (new URL(route.request().url()).pathname.endsWith('/private-cargo')) {
      held = route;
      return;
    }
    await route.fallback();
  });
  await page.goto('/skills');
  await page.getByRole('button', { name: /cargo-workflow/ }).click();
  await expect.poll(() => !!held).toBe(true);
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await page.getByLabel('用户名').fill('another-account');
  await page.getByLabel('密码').fill('fixture-password');
  await page.getByRole('button', { name: /进入工作空间/ }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/skills');
  await expect(page.getByText('暂无私有技能。', { exact: false })).toBeVisible();
  await held!.fulfill({
    json: {
      catalogRevision: 2,
      skill: { skillId: binding.skillId, name: definition.name },
      versions: [version()],
    },
  });
  await expect(page.getByRole('heading', { name: definition.name, exact: true })).toHaveCount(0);
  await expect(page.getByText('0 项 · 修订 0')).toBeVisible();
});

test('任务同时展示创建与使用版本以及船舶、航线、热图产物', async ({ page }) => {
  await chartFixture(page, { role: 'operator' });
  const session = {
    id: 'skill-session',
    ownerId: 'fixture-user',
    title: '复合技能对话',
    createdAt: at,
  };
  const task = {
    id: 'skill-task',
    sessionId: session.id,
    goal: '查询货船并绘制航线和热图',
    intent: 'skill',
    status: 'completed',
    inputRevision: 1,
    resultInputRevision: 1,
    resultVersion: 1,
    historyHours: 24,
    modelCalls: 0,
    toolCalls: 3,
    createdAt: at,
    updatedAt: at,
  };
  const vessels = {
    kind: 'vessel_list',
    inputRevision: 1,
    version: 1,
    total: 0,
    truncated: false,
    items: [],
    asOf: at,
    selection: {},
  };
  const tracks = { ...tracksResult(), kind: 'vessel_tracks', inputRevision: 1, version: 1 };
  const heatmap = {
    kind: 'ais_heatmap',
    inputRevision: 1,
    version: 1,
    query: { bbox: [110, 10, 130, 40], from: '2026-10-16T00:00:00Z', to: at },
    grid: { level: 7, cellDegrees: 2.8125 },
    cells: [],
    totalVessels: 0,
    generatedAt: at,
    metric: 'unique_vessels',
    shipTypeBasis: 'current_profile',
  };
  const artifacts = [vessels, tracks, heatmap].map((payload, index) => ({
    id: `artifact-${index}`,
    ownerId: session.ownerId,
    taskId: task.id,
    stepId: ['cargo', 'route', 'heat'][index],
    kind: payload.kind,
    payload,
    inputRevision: 1,
    modelProjection: {},
    createdAt: at,
  }));
  await page.addInitScript(() =>
    localStorage.setItem('ais-agent-session:fixture-user', 'skill-session'),
  );
  await page.route('**/api/v1/agent/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = path.endsWith('/config')
      ? {
          enabled: true,
          uiEnabled: false,
          dynamicSkillsEnabled: true,
          defaultHistoryHours: 24,
          maxHistoryHours: 168,
          maxModelCalls: 12,
          maxToolCalls: 24,
        }
      : path.endsWith('/sessions')
        ? { items: [session] }
        : path.endsWith('/events')
          ? { items: [], nextCursor: '0' }
          : path.includes('/tasks/')
            ? {
                task,
                results: [],
                steps: [],
                artifacts,
                dynamicSkill: {
                  taskBinding: {
                    ownerId: session.ownerId,
                    taskId: task.id,
                    inputRevision: 1,
                    binding,
                    toolCeiling: definition.toolIds,
                    boundAt: at,
                  },
                  version: version(),
                  calls: [],
                  artifacts,
                  createdVersions: [version()],
                },
              }
            : {
                session,
                tasks: [task],
                messages: [],
                pendingInputRequests: [],
                snapshotCursor: '0',
              };
    await route.fulfill({ json });
  });
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('tab', { name: 'AI 对话' }).click();
  const panel = page.getByTestId('agent-panel');
  await panel.getByRole('button', { name: /查询货船并绘制航线和热图/ }).click();
  await expect(panel.getByLabel('任务技能版本')).toContainText('本次创建');
  await expect(panel.getByLabel('任务技能版本')).toContainText('本次使用');
  await expect(panel.locator('[data-artifact-id]')).toHaveCount(3);
  await expect(panel.getByLabel('技能多步骤产物')).toContainText('船舶清单');
  await expect(panel.getByLabel('技能多步骤产物')).toContainText('历史航线');
  await expect(panel.getByLabel('技能多步骤产物')).toContainText('AIS 热力图');
  await expect(
    panel.getByRole('button', { name: '在海图展示此航线快照', exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole('button', { name: '在海图展示此热力快照', exact: true }),
  ).toBeVisible();
});

test('技能歧义补问必选精确版本并在收起后保留草稿', async ({ page }) => {
  await chartFixture(page, { role: 'operator' });
  const session = {
    id: 'choice-session',
    ownerId: 'fixture-user',
    title: '选择技能',
    createdAt: at,
  };
  let accepted = false;
  const answers: Record<string, unknown>[] = [];
  const task = () => ({
    id: 'choice-task',
    sessionId: session.id,
    goal: '使用货船技能',
    status: accepted ? 'completed' : 'awaiting_input',
    inputRevision: accepted ? 1 : 0,
    resultVersion: 0,
    historyHours: 24,
    createdAt: at,
    updatedAt: at,
  });
  const pending = () => ({
    id: 'choice-request',
    taskId: 'choice-task',
    sessionId: session.id,
    inputRevision: 0,
    pauseGeneration: 1,
    fields: ['skill'],
    reason: 'ambiguous_skill',
    prefill: {
      skillCandidates: [
        { skillId: 'cargo-a', version: '1', name: '货船清单' },
        { skillId: 'cargo-b', version: '2', name: '货船航线热图' },
      ],
    },
    status: accepted ? 'answered' : 'pending',
    response: null,
    createdAt: at,
    answeredAt: null,
  });
  await page.addInitScript(() =>
    localStorage.setItem('ais-agent-session:fixture-user', 'choice-session'),
  );
  await page.route('**/api/v1/agent/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/responses')) {
      answers.push(route.request().postDataJSON());
      accepted = true;
      await route.fulfill({ json: { task: task(), request: pending() } });
      return;
    }
    const json = path.endsWith('/config')
      ? {
          enabled: true,
          uiEnabled: false,
          dynamicSkillsEnabled: true,
          defaultHistoryHours: 24,
          maxHistoryHours: 168,
          maxModelCalls: 12,
          maxToolCalls: 24,
        }
      : path.endsWith('/sessions')
        ? { items: [session] }
        : path.endsWith('/events')
          ? { items: [], nextCursor: '0' }
          : path.includes('/tasks/')
            ? {
                task: task(),
                results: [],
                steps: [],
                pendingInputRequests: accepted ? [] : [pending()],
              }
            : {
                session,
                tasks: [task()],
                messages: [],
                pendingInputRequests: accepted ? [] : [pending()],
                snapshotCursor: '0',
              };
    await route.fulfill({ json });
  });
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('tab', { name: 'AI 对话' }).click();
  await page.getByRole('button', { name: '继续选择', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '补充任务条件' });
  await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(dialog.getByText('请选择本次使用的技能版本。')).toBeVisible();
  await dialog.getByRole('radio', { name: '货船航线热图 · 2' }).check();
  await dialog.getByRole('button', { name: '收起', exact: true }).click();
  await page.getByRole('button', { name: '继续选择', exact: true }).click();
  await expect(dialog.getByRole('radio', { name: '货船航线热图 · 2' })).toBeChecked();
  await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(answers[0]).toMatchObject({
    action: 'accept',
    values: { skillRef: { skillId: 'cargo-b', version: '2' } },
  });
  expect((answers[0]?.values as Record<string, unknown>).skillCandidates).toBeUndefined();
});

test('组合技能无需legacy purpose即可回答情报主题补问', async ({ page }) => {
  await chartFixture(page, { role: 'operator' });
  const session = {
    id: 'topic-session',
    ownerId: 'fixture-user',
    title: '组合情报检索',
    createdAt: at,
  };
  let accepted = false;
  const answers: Record<string, unknown>[] = [];
  const task = () => ({
    id: 'topic-task',
    sessionId: session.id,
    goal: '查询船舶并检索情报',
    intent: 'skill',
    status: accepted ? 'completed' : 'awaiting_input',
    inputRevision: accepted ? 1 : 0,
    resultVersion: 0,
    historyHours: 24,
    createdAt: at,
    updatedAt: at,
  });
  const pending = () => ({
    id: 'topic-request',
    taskId: 'topic-task',
    sessionId: session.id,
    inputRevision: 0,
    pauseGeneration: 1,
    fields: ['topic'],
    reason: 'missing_topic',
    prefill: {},
    status: accepted ? 'answered' : 'pending',
    response: null,
    createdAt: at,
    answeredAt: null,
  });
  await page.addInitScript(() =>
    localStorage.setItem('ais-agent-session:fixture-user', 'topic-session'),
  );
  await page.route('**/api/v1/agent/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/responses')) {
      answers.push(route.request().postDataJSON());
      accepted = true;
      await route.fulfill({ json: { task: task(), request: pending() } });
      return;
    }
    const json = path.endsWith('/config')
      ? {
          enabled: true,
          uiEnabled: false,
          dynamicSkillsEnabled: true,
          defaultHistoryHours: 24,
          maxHistoryHours: 168,
          maxModelCalls: 12,
          maxToolCalls: 24,
        }
      : path.endsWith('/sessions')
        ? { items: [session] }
        : path.endsWith('/events')
          ? { items: [], nextCursor: '0' }
          : path.includes('/tasks/')
            ? {
                task: task(),
                results: [],
                steps: [],
                pendingInputRequests: accepted ? [] : [pending()],
              }
            : {
                session,
                tasks: [task()],
                messages: [],
                pendingInputRequests: accepted ? [] : [pending()],
                snapshotCursor: '0',
              };
    await route.fulfill({ json });
  });
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('tab', { name: 'AI 对话' }).click();
  await page.getByRole('button', { name: '继续选择', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '补充任务条件' });
  await expect(dialog.getByLabel('情报检索类型')).toHaveValue('events');
  await dialog.getByLabel('情报检索主题').fill('航行警告');
  await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(answers[0]).toMatchObject({
    action: 'accept',
    values: { intelligenceQuery: { kind: 'events', keyword: '航行警告' } },
  });
  expect((answers[0]?.values as Record<string, unknown>).purpose).toBeUndefined();
});

test('真实UI消费者连续展示两个步骤产物并回传各自身份，缺失投影拒绝旧缓存', async ({ page }) => {
  const fixture = await dynamicSkillUiFixture(page);
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  await expect.poll(fixture.ready).toBe(true);
  const tracks = fixture.issue('vessel_tracks', 'cargo_tracks');
  await expect
    .poll(() =>
      fixture.receipts.find(
        (receipt) => receipt.commandId === tracks.id && receipt.status === 'succeeded',
      ),
    )
    .toBeTruthy();
  await expect(page.getByTestId('vessel-tracks-legend')).toContainText('海图已展示');
  const heatmap = fixture.issue('ais_heatmap', 'cargo_heatmap');
  await expect
    .poll(() =>
      fixture.receipts.find(
        (receipt) => receipt.commandId === heatmap.id && receipt.status === 'succeeded',
      ),
    )
    .toBeTruthy();
  await expect(page.getByTestId('vessel-tracks-legend')).toContainText('历史航线 · 1 艘');
  await expect(page.getByTestId('vessel-tracks-legend')).toContainText('海图已展示');
  await expect(page.getByTestId('heatmap-legend')).toContainText('海图已展示 · 全区 3 艘');
  expect(fixture.claims).toEqual([tracks.id, heatmap.id]);
  for (const issued of [tracks, heatmap]) {
    const sequence = fixture.receipts.filter((receipt) => receipt.commandId === issued.id);
    expect(sequence.map((receipt) => receipt.status)).toEqual(['executing', 'succeeded']);
    for (const receipt of sequence)
      expect(receipt).toMatchObject({ stepId: issued.stepId, artifactRef: issued.artifactRef });
  }
  expect(tracks.taskId).toBe(heatmap.taskId);
  expect(tracks.artifactRef).not.toBe(heatmap.artifactRef);
  const finalState = fixture.receipts.at(-1)!.state;
  for (const id of ['chart.vessel-tracks', 'chart.heatmap'])
    expect(finalState.components.find((component) => component.id === id)).toMatchObject({
      visible: true,
      open: true,
      loading: false,
    });
  await page.screenshot({ path: '.data/skills-browser-results/skills-two-step-artifacts.png' });

  // Both caches now exist. A new artifact with no claim projection must fail explicitly.
  const missing = fixture.issue('ais_heatmap', 'missing_projection', false);
  await expect
    .poll(
      () =>
        fixture.receipts.find(
          (receipt) => receipt.commandId === missing.id && receipt.status === 'failed',
        )?.error,
    )
    .toBe('UNAVAILABLE');
  expect(
    fixture.receipts.find(
      (receipt) => receipt.commandId === missing.id && receipt.status === 'failed',
    ),
  ).toMatchObject({ stepId: missing.stepId, artifactRef: missing.artifactRef });
  expect(
    fixture.receipts.some(
      (receipt) => receipt.commandId === missing.id && receipt.status === 'succeeded',
    ),
  ).toBe(false);
  await expect(page.getByTestId('heatmap-legend')).toContainText('海图已展示 · 全区 3 艘');
  await expect(page.getByTestId('vessel-tracks-legend')).toContainText('海图已展示');
});
