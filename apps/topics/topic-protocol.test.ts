import { expect, it } from 'vitest';
import { executeExternalTopic } from './protocol';
import type { TopicDataset, TopicInstance } from '../../packages/contracts/topics';
import { fileURLToPath } from 'node:url';
import { CreateTopicInstanceSchema } from '../../packages/contracts/topics';
const instance = { id: 'instance', definitionId: 'port-restriction' } as TopicInstance;
const data = {
  from: '2026-10-01T00:00:00Z',
  to: '2026-10-02T00:00:00Z',
  ais: [],
  intelligence: [],
} as unknown as TopicDataset;
it('accepts the versioned stdio protocol and rejects malformed output', async () => {
  expect(
    await executeExternalTopic(
      JSON.stringify([
        process.execPath,
        '-e',
        'process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({protocolVersion:1,results:[]})))',
      ]),
      instance,
      data,
    ),
  ).toEqual([]);
  await expect(
    executeExternalTopic(
      JSON.stringify([process.execPath, '-e', 'console.log("broken")']),
      instance,
      data,
    ),
  ).rejects.toThrow();
});
it('rejects command injection syntax and terminates a stuck executor', async () => {
  await expect(
    executeExternalTopic('python script.py && echo bad', instance, data),
  ).rejects.toThrow();
  await expect(
    executeExternalTopic(
      JSON.stringify([process.execPath, '-e', 'setInterval(()=>{},1000)']),
      instance,
      data,
      50,
    ),
  ).rejects.toThrow(/timed out/);
});
it('runs the Python example with real nonempty evidence and arbitrary JSON property order', async () => {
  const topic = {
    ...instance,
    ...CreateTopicInstanceSchema.parse({
      definitionId: 'port-restriction',
      name: 'Python',
      config: { bbox: [120, 20, 123, 24] },
      enabled: true,
    }),
  };
  const dataset: TopicDataset = {
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-10-02T00:00:00.000Z',
    queriedAt: '2026-10-02T00:00:00.000Z',
    ais: [
      {
        recordId: 'p1',
        vesselId: 'vessel-1',
        mmsi: '413123456',
        occurredAt: '2026-10-01T12:00:00.000Z',
        longitude: 121,
        latitude: 22,
        speedOverGround: 2,
        shipType: 70,
        raw: { test: true },
      },
    ],
    intelligence: [
      {
        id: 'd1',
        sourceId: 's1',
        externalId: 'notice',
        version: 1,
        status: 'active',
        title: '港口限制',
        kind: 'port-restriction',
        effectiveFrom: '2026-10-01T00:00:00.000Z',
        effectiveTo: null,
        bbox: [120, 20, 123, 24],
        vesselTypes: [70],
        mmsis: [],
        paragraphs: [{ id: 'para', text: '原文' }],
        raw: { text: '原文' },
      },
    ],
  };
  const command = JSON.stringify([
    'python',
    fileURLToPath(new URL('./examples/port_restriction.py', import.meta.url)),
  ]);
  const results = await executeExternalTopic(command, topic, dataset);
  expect(results).toHaveLength(1);
  expect(results[0]?.evidence.ais[0]?.vesselId).toBe('vessel-1');
});
