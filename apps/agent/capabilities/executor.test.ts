import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CapabilityExecutor,
  CapabilityRegistry,
  type CapabilityPorts,
  defineTool,
} from './executor';
const routing = {
  intents: ['ais_heatmap'] as const,
  requiredInputs: { ais_heatmap: ['region', 'time'] as const },
  executionMode: 'local' as const,
  available: true,
};
const identity = {
  ownerId: 'a7ecf638-83f6-4bf3-bd3f-1aaf6303b19f',
  taskId: 'c0e9ea90-ac31-4562-a36c-acfdb71b1e32',
  inputRevision: 2,
  generation: 3,
};
function fixture() {
  const events: string[] = [];
  let active = true;
  const ports: CapabilityPorts = {
    active: async () => {
      events.push('active');
      return active;
    },
    reserve: async () => {
      events.push('reserve');
      return true;
    },
    saveStep: async () => {
      events.push('audit');
      return true;
    },
  };
  const tool = defineTool({
    id: 'query',
    description: '执行查询',
    allowedPhases: ['query'],
    inputSchema: z.strictObject({ n: z.number() }),
    outputSchema: z.strictObject({ count: z.number(), secret: z.string() }),
    handler: async (input) => {
      events.push('handler');
      return { count: input.n, secret: 'local AIS' };
    },
    project: (output) => ({ count: output.count }),
  });
  const registry = new CapabilityRegistry([
    { ...routing, id: 'sample', description: 'sample', tools: [tool] },
  ]);
  return {
    executor: new CapabilityExecutor(registry, ports, { maxToolCalls: 4 }),
    ports,
    events,
    stop: () => {
      active = false;
    },
  };
}
describe('capability executor', () => {
  it('rejects disabled capabilities before using execution ports', async () => {
    const { executor, ports, events } = fixture();
    const disabled = new CapabilityExecutor(
      new CapabilityRegistry([{ ...executor.registry.list()[0]!, available: false }]),
      ports,
    );
    await expect(
      disabled.execute({
        capabilityId: 'sample',
        toolId: 'query',
        phase: 'query',
        input: { n: 1 },
        identity,
      }),
    ).rejects.toThrow('capability unavailable');
    expect(events).toEqual([]);
  });
  it('preserves the stable tool id as the audit step name', async () => {
    const { executor, ports } = fixture();
    const names: string[] = [];
    ports.saveStep = async (_key, name) => {
      names.push(name);
      return true;
    };
    await executor.execute({
      capabilityId: 'sample',
      toolId: 'query',
      phase: 'query',
      input: { n: 1 },
      identity,
    });
    expect(names).toEqual(['query']);
  });
  it('validates, reserves once, projects and audits a local result', async () => {
    const { executor, events } = fixture();
    const result = await executor.execute({
      capabilityId: 'sample',
      toolId: 'query',
      phase: 'query',
      input: { n: 1 },
      identity,
    });
    expect(result).toEqual({ local: { count: 1, secret: 'local AIS' }, model: { count: 1 } });
    expect(events).toEqual(['active', 'reserve', 'handler', 'active', 'audit']);
  });
  it('rejects wrong phase, input and capability before reservation', async () => {
    const { executor, events } = fixture();
    for (const override of [
      { phase: 'finish' },
      { input: { n: '1' } },
      { capabilityId: 'other' },
    ]) {
      await expect(
        executor.execute({
          capabilityId: 'sample',
          toolId: 'query',
          phase: 'query',
          input: { n: 1 },
          identity,
          ...override,
        }),
      ).rejects.toThrow();
    }
    expect(events).toEqual([]);
  });
  it('fences before reservation', async () => {
    const { executor, events, stop } = fixture();
    stop();
    await expect(
      executor.execute({
        capabilityId: 'sample',
        toolId: 'query',
        phase: 'query',
        input: { n: 1 },
        identity,
      }),
    ).rejects.toThrow('fenced');
    expect(events).toEqual(['active']);
  });
  it('stops on budget denial without invoking the handler', async () => {
    const { executor, events, ports } = fixture();
    ports.reserve = async () => {
      events.push('reserve');
      return false;
    };
    await expect(
      executor.execute({
        capabilityId: 'sample',
        toolId: 'query',
        phase: 'query',
        input: { n: 1 },
        identity,
      }),
    ).rejects.toThrow('budget');
    expect(events).toEqual(['active', 'reserve']);
  });
  it('fences loss of ownership after the handler and failed audit writes', async () => {
    const { executor, events, ports } = fixture();
    let activeCalls = 0;
    ports.active = async () => ++activeCalls === 1;
    await expect(
      executor.execute({
        capabilityId: 'sample',
        toolId: 'query',
        phase: 'query',
        input: { n: 1 },
        identity,
      }),
    ).rejects.toThrow('fenced');
    expect(events).toEqual(['reserve', 'handler']);
    ports.active = async () => true;
    ports.saveStep = async () => false;
    await expect(
      executor.execute({
        capabilityId: 'sample',
        toolId: 'query',
        phase: 'query',
        input: { n: 1 },
        identity,
      }),
    ).rejects.toThrow('fenced');
  });
  it('rejects an invalid handler output before projection and audit', async () => {
    const { ports, events } = fixture();
    const tool = defineTool({
      id: 'bad',
      description: 'bad',
      allowedPhases: ['query'],
      inputSchema: z.unknown(),
      outputSchema: z.number(),
      handler: async () => 'wrong' as unknown as number,
      project: () => {
        events.push('project');
      },
    });
    const executor = new CapabilityExecutor(
      new CapabilityRegistry([{ ...routing, id: 'sample', description: 'sample', tools: [tool] }]),
      ports,
    );
    await expect(
      executor.execute({
        capabilityId: 'sample',
        toolId: 'bad',
        phase: 'query',
        input: {},
        identity,
      }),
    ).rejects.toThrow('invalid_output');
    expect(events).toEqual(['active', 'reserve']);
  });
  it('rejects malformed host identity before using ports', async () => {
    const { executor, events } = fixture();
    await expect(
      executor.execute({
        capabilityId: 'sample',
        toolId: 'query',
        phase: 'query',
        input: { n: 1 },
        identity: { ...identity, taskId: 'arbitrary' },
      }),
    ).rejects.toThrow('invalid_input');
    expect(events).toEqual([]);
  });
});
