import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import httpRequest from 'supertest';
import type { Infrastructure } from '@ais/infrastructure';
import * as storage from '../../../../packages/infrastructure/agent-memory';
import { AgentMemoryController } from './memory-controller';
import { createApi } from '../app';
import { AuthService } from '../auth/service';
import { csrfToken } from '../auth/security';

const ownerId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const request = { user: { id: ownerId, role: 'viewer' } } as never;
const mutation = { operationId: id, expectedRevision: 0 };
afterEach(() => vi.restoreAllMocks());
describe('个人记忆HTTP身份、CSRF与Swagger', () => {
  let api: Awaited<ReturnType<typeof createApi>>;
  const origin = 'http://127.0.0.1:13001';
  beforeAll(async () => {
    api = await createApi({} as Infrastructure, { scheduler: false, origins: [origin] });
  });
  afterAll(async () => {
    await api?.stop();
  });
  function authenticate(role: 'viewer' | 'admin', account = ownerId) {
    vi.spyOn(api.app.get(AuthService), 'session').mockResolvedValue({
      user: { id: account, username: 'fixture', role },
      csrfToken: csrfToken('fixture'),
      expiresAt: '2099-01-01T00:00:00Z',
    });
  }
  it('viewer管理个人记忆仍强制可信Origin和CSRF，业务写权限保持独立', async () => {
    authenticate('viewer');
    const write = vi
      .spyOn(storage, 'mutateAgentAccountMemory')
      .mockResolvedValue({ revision: 1, entries: [] });
    const post = () =>
      httpRequest(api.app.getHttpServer())
        .post('/api/v1/agent/memories')
        .set('Cookie', 'ais_session=fixture');
    const body = { ...mutation, category: '偏好', key: '语言', value: '中文' };
    await post()
      .set('Origin', 'http://untrusted.test')
      .set('X-CSRF-Token', csrfToken('fixture'))
      .send(body)
      .expect(403);
    await post().set('Origin', origin).send(body).expect(403);
    expect(write).not.toHaveBeenCalled();
    await post()
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken('fixture'))
      .send(body)
      .expect(200);
    expect(write).toHaveBeenCalledWith(
      expect.anything(),
      ownerId,
      expect.objectContaining({ action: 'remember' }),
    );
    await httpRequest(api.app.getHttpServer())
      .post('/api/v1/agent/sessions')
      .set('Cookie', 'ais_session=fixture')
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken('fixture'))
      .send({ title: '业务写入' })
      .expect(403);
  });
  it('管理员也按认证账号读取，不能使用query指定其他owner', async () => {
    authenticate('admin', id);
    const read = vi
      .spyOn(storage, 'getAgentAccountMemory')
      .mockResolvedValue({ revision: 0, entries: [] });
    await httpRequest(api.app.getHttpServer())
      .get(`/api/v1/agent/memories?ownerId=${ownerId}`)
      .set('Cookie', 'ais_session=fixture')
      .expect(200);
    expect(read).toHaveBeenCalledWith(expect.anything(), id, { includeProposed: true });
  });
  it('原生Swagger包含可生成客户端的记忆读写与409文档', () => {
    const operation = api.openapi.paths['/api/v1/agent/memories']!;
    expect(operation.get?.responses['200']).toBeDefined();
    expect(operation.post?.requestBody).toBeDefined();
    expect(operation.post?.responses['409']).toBeDefined();
    expect(api.openapi.paths['/api/v1/agent/sessions/{id}/memory']?.delete).toBeDefined();
  });
});
describe('个人记忆API边界', () => {
  it('个人账号写入元数据允许viewer，owner始终取认证身份', async () => {
    expect(Reflect.getMetadata('allowViewerWrite', AgentMemoryController)).toBe(true);
    const write = vi
      .spyOn(storage, 'mutateAgentAccountMemory')
      .mockResolvedValue({ revision: 1, entries: [] });
    await new AgentMemoryController({} as Infrastructure).create(
      { ...mutation, category: '偏好', key: '语言', value: '中文' },
      request,
    );
    expect(write).toHaveBeenCalledWith(
      expect.anything(),
      ownerId,
      expect.objectContaining({ ...mutation, action: 'remember' }),
    );
  });
  it('拒绝body中的owner与内部提取action，防止越权或代替确认', async () => {
    const controller = new AgentMemoryController({} as Infrastructure);
    await expect(
      controller.create(
        { ...mutation, ownerId: id, category: '偏好', key: '语言', value: '中文' },
        request,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.create(
        { ...mutation, action: 'propose', category: '偏好', key: '语言', value: '中文' },
        request,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('修订冲突映射409，缺失会话统一404', async () => {
    vi.spyOn(storage, 'mutateAgentAccountMemory').mockRejectedValue(
      new storage.AgentMemoryError('CONFLICT', '记忆已更新'),
    );
    const controller = new AgentMemoryController({} as Infrastructure);
    await expect(controller.confirm(id, mutation, request)).rejects.toMatchObject({ status: 409 });
    vi.spyOn(storage, 'getAgentSessionMemory').mockResolvedValue(null);
    await expect(controller.session(id, request)).rejects.toMatchObject({ status: 404 });
  });
  it('会话解释仅投影对象数量、标签与来源，隐藏原始全量成员', async () => {
    vi.spyOn(storage, 'getAgentSessionMemory').mockResolvedValue({
      sessionId: id,
      revision: 1,
      turnSeq: 2,
      generation: 0,
      summary: '正在讨论查询到的船舶',
      conditions: { region: '渤海' },
      references: [],
      updatedAt: '2026-10-18T00:00:00Z',
      objectSets: [
        {
          id: 'set',
          label: '本次船舶',
          kind: 'vessels',
          turnSeq: 2,
          members: [{ kind: 'vessel', mmsi: '413518000' }],
          targets: [],
          source: {},
        },
      ],
    });
    vi.spyOn(storage, 'getLatestAgentSessionMemoryContext').mockResolvedValue(null);
    const result = await new AgentMemoryController({} as Infrastructure).session(id, request);
    expect(result.objectSets[0]).toMatchObject({ memberCount: 1, label: '本次船舶' });
    expect(result.objectSets[0]).not.toHaveProperty('members');
    expect(result.objectSets[0]).not.toHaveProperty('targets');
  });
});
