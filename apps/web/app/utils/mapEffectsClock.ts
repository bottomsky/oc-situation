import type { MapAttentionRequest, MapEffectFrame } from '../types/mapEffects';
import { MAP_EFFECT_DURATION, sampleMapAttention } from './mapEffects';

interface MapEffectClockOptions {
  frames: { request(callback: FrameRequestCallback): number; cancel(id: number): void };
  onFrame(frame: MapEffectFrame): void;
  shortSide?: () => number;
  timers?: {
    now(): number;
    set(callback: () => void, delay: number): unknown;
    clear(id: unknown): void;
  };
}

/** A single queue and RAF own every attention batch; projection stays with the host. */
export function createMapEffectClock(options: MapEffectClockOptions) {
  const timers = options.timers ?? {
    now: () => performance.now(),
    set: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clear: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  const queue: MapAttentionRequest[] = [];
  const seen = new Set<string>();
  let active = false,
    hidden = false,
    reduced = false,
    disposed = false;
  let raf: number | undefined, previous: number | undefined;
  let timer: unknown, staticSince: number | undefined;
  let time = 0,
    startedAt = 0,
    lastPaint = -Infinity;
  let request: MapAttentionRequest | null = null;
  let current: MapEffectFrame = {
    request: null,
    elapsed: 0,
    phase: 'done',
    visible: false,
    size: 24,
  };
  const emit = (done = false, displayed = request) => {
    const elapsed = done ? MAP_EFFECT_DURATION : Math.max(0, time - startedAt);
    current = {
      // Completion consumers need the request ID, while geometry belongs only to
      // the active animation. Clone so the caller's immutable snapshot survives.
      request: done && displayed ? { ...displayed, targets: [] } : displayed,
      elapsed,
      ...(reduced && !done
        ? { phase: 'static' as const, visible: true, size: 24 }
        : sampleMapAttention(elapsed, options.shortSide?.() ?? 600)),
    };
    options.onFrame(current);
    lastPaint = time;
  };
  const finish = () => {
    const completed = request;
    request = null;
    if (completed) emit(true, completed);
  };
  const stop = () => {
    if (staticSince !== undefined) {
      time += Math.max(0, timers.now() - staticSince);
      staticSince = undefined;
    }
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
    if (raf !== undefined) options.frames.cancel(raf);
    raf = undefined;
    previous = undefined;
  };
  const begin = () => {
    if (!request && active && !hidden) {
      request = queue.shift() ?? null;
      if (request) {
        startedAt = time;
        lastPaint = -Infinity;
      }
    }
  };
  const schedule = () => {
    if (disposed || !active || hidden || !request) return;
    if (reduced) {
      if (staticSince === undefined) {
        staticSince = timers.now();
        emit();
      }
      if (request && active && !hidden && reduced && timer === undefined)
        timer = timers.set(expireStatic, Math.max(0, MAP_EFFECT_DURATION - (time - startedAt)));
    } else if (raf === undefined) raf = options.frames.request(tick);
  };
  const expireStatic = () => {
    timer = undefined;
    if (disposed || !active || hidden || !reduced || !request) return;
    const now = timers.now();
    time += Math.max(0, now - (staticSince ?? now));
    staticSince = now;
    if (time - startedAt >= MAP_EFFECT_DURATION) {
      staticSince = undefined;
      finish();
      begin();
    }
    schedule();
  };
  const tick = (now: number) => {
    raf = undefined;
    if (!active || hidden || reduced || disposed || !request) return;
    if (previous !== undefined) time += Math.max(0, now - previous);
    previous = now;
    const done = time - startedAt >= MAP_EFFECT_DURATION;
    if (done) finish();
    else if (time - lastPaint >= 1000 / 30) emit();
    if (done) {
      previous = undefined;
      begin();
      if (request) emit();
    }
    schedule();
    if (raf === undefined) previous = undefined;
  };
  return {
    enqueue(next: MapAttentionRequest) {
      if (disposed || !next.targets.length || seen.has(next.id)) return false;
      seen.add(next.id);
      queue.push(next);
      begin();
      schedule();
      return true;
    },
    cancel(id?: string) {
      for (let i = queue.length - 1; i >= 0; i--)
        if (id === undefined || queue[i]!.id === id) queue.splice(i, 1);
      if (request && (id === undefined || request.id === id)) {
        stop();
        finish();
        begin();
        schedule();
      }
    },
    update(next: { active: boolean; hidden: boolean; reduced: boolean }) {
      const exiting = active && !next.active;
      if (active !== next.active || hidden !== next.hidden || reduced !== next.reduced) stop();
      active = next.active;
      hidden = next.hidden;
      reduced = next.reduced;
      if (exiting) {
        queue.length = 0;
        finish();
      }
      begin();
      schedule();
    },
    now: () => time,
    current: () => current,
    dispose() {
      active = false;
      disposed = true;
      stop();
      queue.length = 0;
      finish();
    },
  };
}
