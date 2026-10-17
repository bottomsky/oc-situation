interface RenderMap {
  on(type: 'render', listener: () => void): unknown;
  off(type: 'render', listener: () => void): unknown;
  triggerRepaint(): unknown;
  getSource(id: string): unknown;
  isSourceLoaded(id: string): boolean;
}

// GeoJSONSource.setData resolves after its worker has processed that update.
// Wait for a subsequent frame of the same source revision, independent of idle
// (animated highlight icons intentionally keep the map repainting).
export function createSourceRenderAcknowledgements(map: RenderMap) {
  let disposed = false;
  const pending = new Map<string, { token: object; render?: () => void }>();
  const clear = (id: string) => {
    const item = pending.get(id);
    if (item?.render) map.off('render', item.render);
    pending.delete(id);
  };
  return {
    update(id: string, update: () => Promise<void>, displayed: () => void) {
      if (disposed) return;
      clear(id);
      const token = {};
      pending.set(id, { token });
      void (async () => {
        await update();
        if (disposed || pending.get(id)?.token !== token) return;
        const render = () => {
          if (disposed || pending.get(id)?.token !== token) return;
          if (!map.getSource(id) || !map.isSourceLoaded(id)) return;
          clear(id);
          displayed();
        };
        pending.set(id, { token, render });
        map.on('render', render);
        map.triggerRepaint();
      })().catch(() => {
        if (pending.get(id)?.token === token) clear(id);
      });
    },
    dispose() {
      disposed = true;
      for (const id of pending.keys()) clear(id);
    },
  };
}
