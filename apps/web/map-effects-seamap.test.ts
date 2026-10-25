import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { highlightGeoJson } from './app/utils/vesselHighlightsMap';
import { createSourceRenderAcknowledgements } from './app/utils/mapSourceRender';

// Exercise the SFC adapter's actual functions without mounting MapLibre or Nuxt.
function adapter(realAcknowledgements = false) {
  const text = readFileSync(new URL('./app/components/SeaMap.client.vue', import.meta.url), 'utf8');
  const script = text.slice(text.indexOf('>') + 1, text.indexOf('</script>'));
  const ast = ts.createSourceFile('SeaMap.ts', script, ts.ScriptTarget.Latest, true);
  const names = [
    'updateVesselHighlights',
    'updateMapEffectVisibility',
    'flushVesselHighlightsDisplay',
  ];
  const functions = ast.statements
    .filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node))
    .filter((node) => names.includes(node.name?.text ?? ''))
    .map((node) => node.getText(ast));
  const clickHandlers: string[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === 'map.on' &&
      node.arguments[0]?.getText(ast) === "'click'"
    ) {
      const general = node.arguments.length === 2;
      const highlight = node.arguments[1]?.getText(ast) === "'vessel-highlight-marker'";
      if (general || highlight)
        clickHandlers.push(
          `const ${general ? 'mapClick' : 'highlightClick'} = ${node.arguments.at(-1)!.getText(ast)};`,
        );
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const props: Record<string, unknown> = { mapEffects: [], vesselHighlights: [] };
  const source = { setData: vi.fn(async () => {}) };
  const renderListeners = new Set<() => void>();
  const map = {
    getSource: vi.fn(() => source),
    getLayer: vi.fn(() => ({})),
    queryRenderedFeatures: vi.fn(
      (_point: unknown, _options?: { layers: string[] }) =>
        [] as { layer: { id: string }; properties: Record<string, string> }[],
    ),
    project: vi.fn(() => ({ x: 30, y: 30 })),
    getCenter: vi.fn(() => ({ lng: 120 })),
    getCanvas: vi.fn(() => ({ clientWidth: 300, clientHeight: 200 })),
    triggerRepaint: vi.fn(),
    on: vi.fn((_type: string, listener: () => void) => renderListeners.add(listener)),
    off: vi.fn((_type: string, listener: () => void) => renderListeners.delete(listener)),
    isSourceLoaded: vi.fn(() => true),
  };
  const emit = vi.fn();
  const opacity = vi.fn();
  const callbacks: (() => void)[] = [];
  const writes: Promise<unknown>[] = [];
  const manualAcknowledgements = {
    update: vi.fn((_id: string, update: () => Promise<unknown>, displayed: () => void) => {
      writes.push(update());
      callbacks.push(displayed);
    }),
  };
  const sourceAcknowledgements = realAcknowledgements
    ? createSourceRenderAcknowledgements(map)
    : manualAcknowledgements;
  const code = ts.transpileModule(
    `let highlightSourceSignature = ''; let hiddenEffectKeys = new Set<string>();
     let pendingVesselHighlightsDisplay: unknown; let disposed = false;
     const measure = { value: false }; const drawMode = { value: 'cancel' };
     const queryingRegion = { value: false }; const intelligenceLayerIds = ['intelligence-location-fill'];
     ${functions.join('\n')}
     ${clickHandlers.join('\n')}
     return { mapClick, highlightClick, measure, drawMode, queryingRegion, ${names.filter((name) => functions.some((fn) => fn.startsWith(`function ${name}(`))).join(',')} };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  ).outputText;
  const runtime = new Function(
    'props',
    'map',
    'emit',
    'sourceAcknowledgements',
    'highlightGeoJson',
    'updateMapEffectOpacity',
    code,
  )(props, map, emit, sourceAcknowledgements, highlightGeoJson, opacity);
  const render = () => [...renderListeners].forEach((listener) => listener());
  return { runtime, props, map, source, emit, opacity, callbacks, writes, render };
}

const target = {
  key: 'vessel:123456789',
  icon: 'vessel' as const,
  bearing: 30,
  geometries: [{ type: 'Point' as const, coordinates: [120, 30] }],
};
const vessel = { mmsi: '123456789', lon: 120, lat: 30, effectId: 'highlight-1' };

describe('SeaMap shared effect adapter', () => {
  it('updates visual data once while acknowledging the original vessel snapshot identity', async () => {
    const { runtime, props, source, emit, callbacks, writes } = adapter();
    props.mapEffects = [target];
    props.vesselHighlights = [vessel];
    const snapshot = props.vesselHighlights;
    runtime.updateVesselHighlights();
    await Promise.all(writes);
    callbacks.at(-1)!();
    expect(emit).toHaveBeenCalledWith('vesselHighlightsDisplayed', snapshot);
    expect(emit.mock.calls.find(([name]) => name === 'vesselHighlightsDisplayed')![1]).toBe(
      snapshot,
    );
    props.mapEffects = [{ ...target, effectId: 'attention-2', observedAt: '2026-10-25' }];
    runtime.updateVesselHighlights();
    await Promise.all(writes);
    expect(source.setData).toHaveBeenCalledTimes(1);
  });

  it('restores departed hidden keys using feature state without rewriting the source', () => {
    const { runtime, props, source, opacity, map } = adapter();
    props.effectHiddenKeys = ['vessel:1', 'vessel:2'];
    runtime.updateMapEffectVisibility();
    props.effectHiddenKeys = ['vessel:2'];
    runtime.updateMapEffectVisibility();
    expect(opacity).toHaveBeenCalledWith(map, ['vessel:1'], 1);
    expect(opacity).toHaveBeenCalledWith(map, ['vessel:1', 'vessel:2'], 0);
    const calls = opacity.mock.calls.length;
    runtime.updateMapEffectVisibility();
    expect(opacity).toHaveBeenCalledTimes(calls);
    expect(source.setData).not.toHaveBeenCalled();
  });

  it('waits through a muted visible frame and acknowledges on the next visible frame', async () => {
    const { runtime, props, emit, callbacks, writes } = adapter();
    props.mapEffects = [target];
    props.vesselHighlights = [vessel];
    props.effectMutedKeys = [target.key];
    runtime.updateVesselHighlights();
    await Promise.all(writes);
    callbacks.at(-1)!();
    expect(emit.mock.calls.filter(([name]) => name === 'vesselHighlightsDisplayed')).toHaveLength(
      0,
    );
    props.effectMutedKeys = [];
    runtime.flushVesselHighlightsDisplay();
    expect(emit).toHaveBeenCalledWith('vesselHighlightsDisplayed', props.vesselHighlights);
  });

  it('waits for every visible member of a mixed snapshot to leave its muted phase', async () => {
    const { runtime, props, emit, callbacks, writes } = adapter();
    props.mapEffects = [target];
    props.vesselHighlights = [vessel, { ...vessel, mmsi: '987654321' }];
    props.effectMutedKeys = [target.key];
    runtime.updateVesselHighlights();
    await Promise.all(writes);
    callbacks.at(-1)!();
    expect(emit.mock.calls.filter(([name]) => name === 'vesselHighlightsDisplayed')).toHaveLength(
      0,
    );
    props.effectMutedKeys = [];
    runtime.flushVesselHighlightsDisplay();
    expect(emit).toHaveBeenCalledWith('vesselHighlightsDisplayed', props.vesselHighlights);
  });

  it('acknowledges offscreen and empty snapshots even during the muted phase', async () => {
    const { runtime, props, map, emit, callbacks, writes } = adapter();
    props.mapEffects = [target];
    props.vesselHighlights = [vessel];
    props.effectMutedKeys = [target.key];
    map.project.mockReturnValue({ x: -50, y: 30 });
    runtime.updateVesselHighlights();
    await Promise.all(writes);
    callbacks.at(-1)!();
    expect(emit.mock.calls.filter(([name]) => name === 'vesselHighlightsDisplayed')).toHaveLength(
      1,
    );
    props.vesselHighlights = [];
    runtime.updateVesselHighlights();
    await Promise.all(writes);
    callbacks.at(-1)!();
    expect(emit.mock.calls.filter(([name]) => name === 'vesselHighlightsDisplayed')).toHaveLength(
      2,
    );
  });

  it('acknowledges the shared snapshot only after its source write and a subsequent real frame', async () => {
    const { runtime, props, source, emit, render } = adapter(true);
    props.vesselHighlights = undefined;
    props.mapEffects = [{ ...target, key: 'object:port-1:current' }];
    const snapshot = props.mapEffects;
    let finishWrite!: () => void;
    const write = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    source.setData.mockImplementationOnce(() => write);
    runtime.updateVesselHighlights();
    render();
    expect(emit).not.toHaveBeenCalled();
    finishWrite();
    await write;
    await Promise.resolve();
    expect(emit).not.toHaveBeenCalled();
    render();
    expect(emit).toHaveBeenCalledExactlyOnceWith('mapEffectsDisplayed', snapshot);
    expect(emit.mock.calls[0]![1]).toBe(snapshot);
  });

  it('rejects a stale shared snapshot and only confirms the current original array', async () => {
    const { runtime, props, emit, render } = adapter(true);
    props.vesselHighlights = undefined;
    props.mapEffects = [target];
    runtime.updateVesselHighlights();
    await Promise.resolve();
    props.mapEffects = [{ ...target, key: 'object:replacement:current' }];
    const current = props.mapEffects;
    render();
    expect(emit).not.toHaveBeenCalled();
    runtime.updateVesselHighlights();
    await Promise.resolve();
    render();
    expect(emit).toHaveBeenCalledExactlyOnceWith('mapEffectsDisplayed', current);
    expect(emit.mock.calls[0]![1]).toBe(current);
  });

  it('publishes a blank click only after all selectable hit tests miss', () => {
    const { runtime, map, emit } = adapter();
    const click = { originalEvent: { button: 0 }, point: { x: 30, y: 30 } };
    runtime.mapClick(click);
    expect(emit).toHaveBeenCalledWith('blank');
    emit.mockClear();
    map.queryRenderedFeatures.mockImplementation(
      (_point: unknown, options?: { layers: string[] }) =>
        options?.layers.includes('vessel-highlight-marker')
          ? [{ layer: { id: 'vessel-highlight-marker' }, properties: { key: 'object:1' } }]
          : [],
    );
    runtime.mapClick(click);
    expect(emit).not.toHaveBeenCalled();
  });

  it('keeps right click, drawing, and region gestures out of blank selection', () => {
    const { runtime, props, emit } = adapter();
    const click = { originalEvent: { button: 0 }, point: { x: 30, y: 30 } };
    runtime.mapClick({ ...click, originalEvent: { button: 2 } });
    runtime.drawMode.value = 'select';
    runtime.mapClick(click);
    runtime.drawMode.value = 'cancel';
    props.selectingRegion = true;
    runtime.mapClick(click);
    expect(emit).not.toHaveBeenCalled();
  });

  it('routes a generic glyph by entity key and preserves vessel selection behavior', () => {
    const { runtime, props, emit } = adapter();
    const key = 'object:port:1:2026-10-25T12:00:00Z';
    props.mapEffects = [
      { ...target, key, kind: 'object', id: 'port:1', revision: '2026-10-25T12:00:00Z' },
    ];
    const click = {
      originalEvent: { button: 0 },
      point: { x: 30, y: 30 },
      features: [{ properties: { key } }],
    };
    runtime.highlightClick(click);
    expect(emit).toHaveBeenCalledExactlyOnceWith('effectSelect', {
      kind: 'object',
      id: 'port:1',
      revision: '2026-10-25T12:00:00Z',
      geometries: target.geometries,
    });
    emit.mockClear();
    props.mapEffects = [target];
    runtime.highlightClick({ ...click, features: [{ properties: { key: target.key } }] });
    expect(emit).toHaveBeenCalledExactlyOnceWith('select', vessel.mmsi);
  });
});
