import { expect, it, vi } from 'vitest';
import type { Infrastructure } from '@ais/infrastructure';
import { MapController } from './controller';
import { VesselsController } from '../vessels/controller';

it('uses indexed planar WGS84 geometry for wide and global rectangles', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const api = new MapController({ pool: { query } } as unknown as Infrastructure);
  await api.get({ bbox: '-180,-90,180,90', zoom: 8 });
  expect(query.mock.calls[0]![0]).toContain('p.location::geometry');
  expect(query.mock.calls[0]![0]).not.toContain('::geography');
});
it('hides latest positions immediately at 30 days while preserving static vessel data', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  await new VesselsController({ pool: { query } } as unknown as Infrastructure).list({});
  expect(query.mock.calls[0]![0]).toContain("p.observed_at>=now()-interval '30 days'");
});
