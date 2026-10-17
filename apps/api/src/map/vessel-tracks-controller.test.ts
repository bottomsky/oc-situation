import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { VesselTracksController } from './vessel-tracks-controller';
import { VesselTracksQuerySchema } from '../../../../packages/contracts/vessel-tracks';
import { parse } from '../common';

describe('read-only vessel tracks HTTP contract', () => {
  it('allows authenticated viewers through the existing POST security guard', () => {
    const handler = VesselTracksController.prototype.query;
    expect(Reflect.getMetadata('role', handler)).toBe('viewer');
    expect(Reflect.getMetadata('allowViewerWrite', handler)).toBe(true);
    expect(Reflect.getMetadata('__httpCode__', handler)).toBe(200);
  });
  it('accepts structured selectors and refuses query-shape coercion or extra body fields', () => {
    const body = {
      bbox: [170, -10, -170, 10],
      from: '2026-10-16T00:00:00Z',
      to: '2026-10-17T00:00:00Z',
      selector: { model: '  052D  ' },
    };
    expect(parse(VesselTracksQuerySchema, body).selector.model).toBe('052D');
    expect(() => parse(VesselTracksQuerySchema, { ...body, bbox: '170,-10,-170,10' })).toThrow();
    expect(() => parse(VesselTracksQuerySchema, { ...body, maxVessels: 51 })).toThrow();
    expect(() => parse(VesselTracksQuerySchema, { ...body, ownerId: 'spoofed' })).toThrow();
  });
});
