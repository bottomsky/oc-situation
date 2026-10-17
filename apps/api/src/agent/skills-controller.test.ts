import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import httpRequest from 'supertest';
import { createApi } from '../app';
import { AuthService } from '../auth/service';
import { csrfToken } from '../auth/security';
import type { Infrastructure } from '@ais/infrastructure';
import * as storage from '../../../../packages/infrastructure/dynamic-skills';
import { SkillsController } from './skills-controller';

const ownerId = '11111111-1111-4111-8111-111111111111';
const request = { user: { id: ownerId } } as never;
const original = process.env.AGENT_DYNAMIC_SKILLS_ENABLED;
afterEach(() => {
  vi.restoreAllMocks();
  if (original === undefined) delete process.env.AGENT_DYNAMIC_SKILLS_ENABLED;
  else process.env.AGENT_DYNAMIC_SKILLS_ENABLED = original;
});

describe('账号技能HTTP权限、Origin与CSRF', () => {
  let api: Awaited<ReturnType<typeof createApi>>;
  const origin = 'http://127.0.0.1:13001';
  beforeAll(async () => {
    api = await createApi({} as Infrastructure, { scheduler: false, origins: [origin] });
  });
  afterAll(async () => {
    await api?.stop();
  });
  function authenticate(role: 'viewer' | 'operator' | 'admin', id = ownerId) {
    vi.spyOn(api.app.get(AuthService), 'session').mockResolvedValue({
      user: { id, username: 'fixture', role },
      csrfToken: csrfToken('fixture'),
      expiresAt: '2099-01-01T00:00:00Z',
    });
  }
  it('viewer可读自己目录，写入被全局Guard拒绝', async () => {
    authenticate('viewer');
    vi.spyOn(storage, 'listOwnedSkills').mockResolvedValue({ catalogRevision: 0, items: [] });
    await httpRequest(api.app.getHttpServer())
      .get('/api/v1/agent/skills')
      .set('Cookie', 'ais_session=fixture')
      .expect(200);
    await httpRequest(api.app.getHttpServer())
      .post('/api/v1/agent/skills/publish')
      .set('Cookie', 'ais_session=fixture')
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken('fixture'))
      .send({})
      .expect(403);
  });
  it('operator写入需要可信Origin和当前会话CSRF', async () => {
    authenticate('operator');
    process.env.AGENT_DYNAMIC_SKILLS_ENABLED = 'true';
    const write = vi
      .spyOn(storage, 'setOwnedSkillEnabled')
      .mockResolvedValue({ catalogRevision: 1, skill: {} as never });
    const body = { operationId: ownerId, expectedCatalogRevision: 0, enabled: false };
    const put = () =>
      httpRequest(api.app.getHttpServer())
        .put('/api/v1/agent/skills/private-skill/state')
        .set('Cookie', 'ais_session=fixture');
    await put()
      .set('Origin', 'http://untrusted.test')
      .set('X-CSRF-Token', csrfToken('fixture'))
      .send(body)
      .expect(403);
    await put().set('Origin', origin).send(body).expect(403);
    expect(write).not.toHaveBeenCalled();
    await put()
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken('fixture'))
      .send(body)
      .expect(200);
    expect(write).toHaveBeenCalledWith(expect.anything(), ownerId, 'private-skill', body);
  });
  it('管理员请求仍只传当前账号身份给仓储', async () => {
    const other = '22222222-2222-4222-8222-222222222222';
    authenticate('admin', other);
    const read = vi.spyOn(storage, 'getOwnedSkill').mockResolvedValue(null);
    await httpRequest(api.app.getHttpServer())
      .get('/api/v1/agent/skills/private-skill')
      .set('Cookie', 'ais_session=fixture')
      .expect(404);
    expect(read).toHaveBeenCalledWith(expect.anything(), other, 'private-skill');
  });
});
describe('账号技能API边界', () => {
  it('功能关闭后继续读取当前账号历史目录', async () => {
    delete process.env.AGENT_DYNAMIC_SKILLS_ENABLED;
    const read = vi
      .spyOn(storage, 'listOwnedSkills')
      .mockResolvedValue({ catalogRevision: 0, items: [] });
    const controller = new SkillsController({} as Infrastructure);
    await expect(controller.list(request)).resolves.toEqual({ catalogRevision: 0, items: [] });
    expect(read).toHaveBeenCalledWith(expect.anything(), ownerId);
  });
  it('功能关闭时在任何写入前拒绝发布', async () => {
    delete process.env.AGENT_DYNAMIC_SKILLS_ENABLED;
    await expect(
      new SkillsController({} as Infrastructure).publish({}, request),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('读取其他账号或缺失资源统一404', async () => {
    vi.spyOn(storage, 'getOwnedSkill').mockResolvedValue(null);
    await expect(
      new SkillsController({} as Infrastructure).detail('private-skill', request),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('拒绝客户端指定owner，目录冲突映射409', async () => {
    process.env.AGENT_DYNAMIC_SKILLS_ENABLED = 'true';
    const controller = new SkillsController({} as Infrastructure);
    await expect(
      controller.state(
        'private-skill',
        { enabled: true, operationId: ownerId, expectedCatalogRevision: 0, ownerId },
        request,
      ),
    ).rejects.toMatchObject({ status: 400 });
    vi.spyOn(storage, 'setOwnedSkillEnabled').mockRejectedValue(
      new storage.DynamicSkillError('conflict', '目录已变化'),
    );
    await expect(
      controller.state(
        'private-skill',
        { enabled: true, operationId: ownerId, expectedCatalogRevision: 0 },
        request,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});
