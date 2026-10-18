import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
/** All chart entry points must configure the bundled worker before creating their first map. */
export function configureMapLibreWorker() {
  setWorkerUrl(workerUrl);
}
