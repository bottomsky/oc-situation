import { expect, it } from 'vitest';
import { topicTargetConfig } from './app/utils/topicConfig';
import { CreateTopicInstanceSchema } from '@ais/contracts';
it.each(['vessel-reachability', 'navigation-warning-impact'])(
  '%s 必须配置有效固定单船，切回规则时不发送空目标',
  (definitionId) => {
    expect(() => topicTargetConfig(definitionId, '')).toThrow('MMSI');
    const target = topicTargetConfig(definitionId, '123456789');
    expect(
      CreateTopicInstanceSchema.safeParse({
        definitionId,
        name: '测试',
        config: { bbox: [120, 30, 121, 31], ...target },
      }).success,
    ).toBe(true);
    expect(() => topicTargetConfig(definitionId, '223456789', '123456789')).toThrow('固定');
    expect(topicTargetConfig('port-restriction', '')).toEqual({});
    expect(topicTargetConfig('area-low-speed-notice', '123456789')).toEqual({});
  },
);
