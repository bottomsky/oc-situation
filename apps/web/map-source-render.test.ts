import { expect, it, vi } from 'vitest';
import { createSourceRenderAcknowledgements } from './app/utils/mapSourceRender';

it('worker已处理指定更新且随后render完成即确认，无需等待全局idle', async () => {
  const renders = new Set<() => void>();
  const map = {
    on: (_: 'render', cb: () => void) => renders.add(cb),
    off: (_: 'render', cb: () => void) => renders.delete(cb),
    triggerRepaint: vi.fn(),
    getSource: () => true,
    isSourceLoaded: () => true,
  };
  const ack = createSourceRenderAcknowledgements(map);
  let complete!: () => void;
  const done = vi.fn();
  ack.update(
    'heatmap',
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
    done,
  );
  for (const render of renders) render();
  expect(done).not.toHaveBeenCalled();
  complete();
  await Promise.resolve();
  for (const render of [...renders]) render();
  expect(done).toHaveBeenCalledOnce();
  ack.dispose();
});

it('后来的源版本覆盖前者，卸载后迟到worker不能确认', async () => {
  const renders = new Set<() => void>();
  const map = {
    on: (_: 'render', cb: () => void) => renders.add(cb),
    off: (_: 'render', cb: () => void) => renders.delete(cb),
    triggerRepaint: vi.fn(),
    getSource: () => true,
    isSourceLoaded: () => true,
  };
  const ack = createSourceRenderAcknowledgements(map);
  let first!: () => void;
  const obsolete = vi.fn();
  const done = vi.fn();
  ack.update(
    'tracks',
    () =>
      new Promise<void>((resolve) => {
        first = resolve;
      }),
    obsolete,
  );
  ack.update('tracks', () => Promise.resolve(), done);
  await Promise.resolve();
  for (const render of [...renders]) render();
  first();
  await Promise.resolve();
  for (const render of [...renders]) render();
  expect(done).toHaveBeenCalledOnce();
  expect(obsolete).not.toHaveBeenCalled();
  ack.update('tracks', () => Promise.resolve(), obsolete);
  ack.dispose();
  await Promise.resolve();
  expect(renders.size).toBe(0);
});
