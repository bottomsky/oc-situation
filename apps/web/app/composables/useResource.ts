export function useResource<T>(path: string, initial: T) {
  const { api, notice } = usePlatform();
  const data = ref<T>(initial);
  const busy = ref(false);
  const error = ref('');
  async function load() {
    busy.value = true;
    error.value = '';
    try {
      data.value = await api<T>(path);
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      busy.value = false;
    }
  }
  async function mutate(
    url: string,
    method: 'POST' | 'PUT' | 'DELETE',
    body?: unknown,
    idempotent = false,
  ) {
    busy.value = true;
    error.value = '';
    try {
      const result = await api(url, { method, body, idempotent });
      await load();
      notice.value = '操作已保存';
      return result;
    } catch (e) {
      error.value = (e as Error).message;
      return null;
    } finally {
      busy.value = false;
    }
  }
  onMounted(load);
  return { data, busy, error, load, mutate };
}
