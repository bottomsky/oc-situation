import { describe, expect, it } from 'vitest';
import { commandReceiptIdentity, commandPresentation } from './app/utils/agentArtifacts';

describe('持久产物界面命令', () => {
  it('回执固定返回认领命令的步骤与产物引用', () => {
    const artifactRef = '11111111-1111-4111-8111-111111111111';
    expect(commandReceiptIdentity({ stepId: 'step-a', artifactRef })).toEqual({
      stepId: 'step-a',
      artifactRef,
    });
    expect(commandReceiptIdentity({})).toEqual({});
  });
  it('持久产物缺少服务端投影时拒绝展示旧缓存', () => {
    expect(() => commandPresentation(undefined, 'a', { old: true })).toThrow('UNAVAILABLE');
    const projection = { trusted: true };
    expect(commandPresentation(projection, 'a', null)).toBe(projection);
    expect(commandPresentation(undefined, undefined, projection)).toBe(projection);
  });
});
