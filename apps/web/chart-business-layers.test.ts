import { describe, expect, it } from 'vitest';
import type { LayerSpecification, SourceSpecification } from 'maplibre-gl';
import {
  registerChartBusinessLayers,
  type ChartBusinessMapPort,
} from './app/utils/chartBusinessLayers';
import { vesselSymbolLayout } from './app/utils/vesselMarkers';

class BusinessPort implements ChartBusinessMapPort {
  sources = new Map<string, SourceSpecification>();
  layers = new Map<string, LayerSpecification>();
  images = new Set<string>();
  getSource(id: string) {
    return this.sources.get(id);
  }
  getLayer(id: string) {
    return this.layers.get(id);
  }
  hasImage(id: string) {
    return this.images.has(id);
  }
  addImage(id: string) {
    if (this.images.has(id)) throw new Error('duplicate image');
    this.images.add(id);
  }
  addSource(id: string, source: SourceSpecification) {
    if (this.sources.has(id)) throw new Error('duplicate source');
    this.sources.set(id, source);
  }
  addLayer(layer: LayerSpecification) {
    if (this.layers.has(layer.id)) throw new Error('duplicate layer');
    this.layers.set(layer.id, layer);
  }
}
const grid = { type: 'FeatureCollection' as const, features: [] };

describe('chart business source restoration', () => {
  it('registers icons and sources once per style and preserves the direction layouts', () => {
    const port = new BusinessPort();
    registerChartBusinessLayers(port, grid);
    registerChartBusinessLayers(port, grid);
    expect(port.sources.size).toBe(7);
    expect(port.images.size).toBe(6);
    expect(port.layers.get('vessels')).toMatchObject({ layout: vesselSymbolLayout });
    expect(port.layers.get('frame')).toMatchObject({
      layout: { ...vesselSymbolLayout, 'icon-size': 1.3 },
    });
    expect(port.layers.get('clusters')).toMatchObject({
      filter: ['==', ['get', 'kind'], 'cluster'],
    });
    expect(port.layers.get('evidence-region-line')).toMatchObject({
      paint: { 'line-dasharray': [3, 2] },
    });
  });

  it('reinstalls track, frame, evidence and synthetic icons after style replacement', () => {
    const port = new BusinessPort();
    registerChartBusinessLayers(port, grid);
    port.sources.clear();
    port.layers.clear();
    port.images.clear();
    registerChartBusinessLayers(port, grid);
    for (const id of ['track', 'frame', 'evidence-points', 'evidence-track', 'evidence-region'])
      expect(port.sources.get(id)).toMatchObject({ type: 'geojson' });
    expect(port.images.has('vessel-sample-direction')).toBe(true);
    expect(port.images.has('vessel-sample-unknown')).toBe(true);
    expect(port.layers.size).toBe(9);
  });
});
