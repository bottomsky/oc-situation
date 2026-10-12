import type { Bbox } from '@ais/contracts';

export function parseBbox(input: string): Bbox {
  const parts = input.split(',').map((part) => part.trim());
  const values = parts.map(Number);
  if (parts.length !== 4 || parts.some((part) => !part) || values.some((v) => !Number.isFinite(v)))
    throw new Error('范围需填写西、南、东、北四个坐标，以英文逗号分隔');
  const [w, s, e, n] = values as Bbox;
  if (
    Math.abs(w) > 180 ||
    Math.abs(e) > 180 ||
    Math.abs(s) > 90 ||
    Math.abs(n) > 90 ||
    s >= n ||
    w === e
  )
    throw new Error('请检查经纬度范围：经度 ±180°，纬度 ±90°，南界小于北界');
  return [w, s, e, n];
}

export function createFeedSync<T>(
  fetchPage: (cursor: string) => Promise<{ items: T[]; nextCursor: string | null }>,
  deliver: (items: T[]) => void,
) {
  let cursor = '0';
  let pending: Promise<void> | null = null;
  let requested = false;
  let generation = 0;
  async function drain(current: number) {
    do {
      requested = false;
      for (;;) {
        const page = await fetchPage(cursor);
        if (current !== generation) return;
        if (page.items.length) deliver(page.items);
        const next = page.nextCursor;
        if (!next || next === cursor || !page.items.length) break;
        cursor = next;
      }
    } while (requested);
  }
  return {
    getCursor: () => cursor,
    reset() {
      generation++;
      cursor = '0';
      pending = null;
      requested = false;
    },
    refresh(): Promise<void> {
      requested = true;
      const current = generation;
      pending ??= drain(current).finally(() => {
        if (current === generation) pending = null;
      });
      return pending;
    },
  };
}
