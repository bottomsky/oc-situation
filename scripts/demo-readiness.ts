import { setTimeout as delay } from 'node:timers/promises';
import { rawPublicationReady, type busHealth } from '@ais/infrastructure';

type BusHealth = {
  ready: boolean;
  reasons: string[];
  streams?: { name: string; messages: number }[];
};
type WaitOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
  onProgress?: (message: string) => void;
};

export async function recoverDemoCollection(
  readHealth: () => Promise<Awaited<ReturnType<typeof busHealth>>>,
  startCollectors: () => void,
  options: WaitOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  options.onProgress?.('恢复阶段 1/2：先运行清洗、写入和归档消费者，等待数据流允许发布。');
  await waitForDemoBus(
    async () => {
      const health = await readHealth();
      return { ...health, ready: rawPublicationReady(health) };
    },
    { ...options, timeoutMs },
  );
  if (options.signal?.aborted) throw new Error('演示启动已中止：停止信号或子进程退出。');
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0)
    throw new Error('演示积压恢复等待超时：采集阶段尚未启动，现有队列和数据已保留。');
  options.onProgress?.('恢复阶段 2/2：启动采集消费者处理已有任务，等待全流允许接收新任务。');
  startCollectors();
  await waitForDemoBus(readHealth, { ...options, timeoutMs: remainingMs });
}

export async function waitForDemoBus(
  readHealth: () => Promise<BusHealth>,
  options: WaitOptions = {},
): Promise<void> {
  const recovery = new AbortController();
  const timeoutMs = options.timeoutMs ?? 120_000;
  let reasons = '尚未取得总线状态';
  const abort = () => recovery.abort(new Error('演示启动已中止：停止信号或子进程退出。'));
  const timer = setTimeout(
    () =>
      recovery.abort(
        new Error(
          `演示积压恢复等待超时（${Math.ceil(timeoutMs / 1000)} 秒）：${reasons}。请检查消费者日志及未完成归档/任务后重试；现有队列和数据已保留。`,
        ),
      ),
    timeoutMs,
  );
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });

  let rejectAbort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(recovery.signal.reason);
    if (recovery.signal.aborted) rejectAbort();
    else recovery.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  const polling = async () => {
    let previousReasons: string | undefined;
    let lastProgress = 0;
    while (true) {
      recovery.signal.throwIfAborted();
      const health = await readHealth();
      recovery.signal.throwIfAborted();
      if (health.ready) return;
      reasons = health.reasons.join(', ') || '总线处于暂停状态';
      if (health.reasons.some((reason) => !reason.startsWith('pressure:')))
        throw new Error(`演示总线拓扑异常：${reasons}。请修复配置或消费者后重试。`);
      if (previousReasons !== reasons || Date.now() - lastProgress >= 15_000) {
        const backlog = health.streams
          ?.map((stream) => `${stream.name}=${stream.messages}`)
          .join(', ');
        options.onProgress?.(
          `正在等待消费者恢复历史积压：${reasons}${backlog ? `；剩余消息 ${backlog}` : ''}。`,
        );
        previousReasons = reasons;
        lastProgress = Date.now();
      }
      await delay(options.pollIntervalMs ?? 1000, undefined, { signal: recovery.signal });
    }
  };
  try {
    await Promise.race([polling(), interrupted]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    recovery.signal.removeEventListener('abort', rejectAbort);
    recovery.abort();
  }
}
