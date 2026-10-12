import type { AnalysisResult } from '@ais/contracts';
import { createRequestGeneration } from '../utils/chartWorkspace';

/** One page-owned result collection feeds the push panel, strip and bottom table. */
export function useTopicResults() {
  const { api } = usePlatform();
  const { analysisVersion } = useFusionEvents();
  const items = ref<AnalysisResult[]>([]);
  const busy = ref(false);
  const error = ref('');
  const selecting = ref('');
  const evidence = ref<AnalysisResult | null>(null);
  const mapEvidence = ref<AnalysisResult | null>(null);
  const requests = createRequestGeneration();
  const selections = createRequestGeneration();
  async function load() {
    const current = requests.next();
    busy.value = true;
    error.value = '';
    try {
      const response = await api<{ items: AnalysisResult[] }>('/analysis/results?limit=30');
      if (requests.isCurrent(current)) items.value = response.items;
    } catch (e) {
      if (requests.isCurrent(current)) error.value = (e as Error).message;
    } finally {
      if (requests.isCurrent(current)) busy.value = false;
    }
  }
  async function select(item: AnalysisResult) {
    const current = selections.next();
    selecting.value = item.id;
    error.value = '';
    try {
      const result = await api<AnalysisResult>('/analysis/results/' + encodeURIComponent(item.id));
      if (selections.isCurrent(current)) {
        evidence.value = structuredClone(result);
        mapEvidence.value = structuredClone(result);
      }
    } catch (e) {
      if (selections.isCurrent(current)) error.value = (e as Error).message;
    } finally {
      if (selections.isCurrent(current)) selecting.value = '';
    }
  }
  function locate(result: AnalysisResult) {
    mapEvidence.value = JSON.parse(JSON.stringify(result)) as AnalysisResult;
  }
  function revision(result: AnalysisResult) {
    evidence.value = JSON.parse(JSON.stringify(result)) as AnalysisResult;
    locate(result);
  }
  function close() {
    selections.next();
    evidence.value = null;
    mapEvidence.value = null;
    selecting.value = '';
  }
  watch(analysisVersion, load);
  onMounted(load);
  onBeforeUnmount(() => {
    requests.next();
    selections.next();
  });
  return {
    items,
    busy,
    error,
    selecting,
    evidence,
    mapEvidence,
    load,
    select,
    locate,
    revision,
    close,
  };
}
