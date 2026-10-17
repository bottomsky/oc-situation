import type { z } from 'zod';
import {
  DynamicSkillDefinitionSchema,
  type DynamicSkillCatalog,
  type DynamicSkillDefinition,
  DynamicSkillDetailSchema,
} from '../../../../packages/contracts/dynamic-skills';
import { canOperate } from '../utils/display';

export function useSkills() {
  const { api, session } = usePlatform();
  const catalog = ref<DynamicSkillCatalog>({ catalogRevision: 0, items: [] });
  const detail = ref<z.infer<typeof DynamicSkillDetailSchema> | null>(null);
  const enabled = ref(false);
  const busy = ref(false);
  const detailBusy = ref(false);
  const error = ref('');
  const notice = ref('');
  const selectedId = ref('');
  const canWrite = computed(() => enabled.value && canOperate(session.value?.user.role));
  let generation = 0;
  let selection = 0;
  let loading = 0;
  const operations = new Map<string, string>();
  watch(
    () => session.value?.user.id,
    () => {
      generation++;
      selection++;
      loading++;
      catalog.value = { catalogRevision: 0, items: [] };
      detail.value = null;
      selectedId.value = '';
      enabled.value = false;
      busy.value = false;
      detailBusy.value = false;
      error.value = '';
      notice.value = '';
      operations.clear();
    },
  );
  async function load() {
    const turn = generation;
    const ticket = ++loading;
    busy.value = true;
    error.value = '';
    try {
      const [config, result] = await Promise.all([
        api<{ dynamicSkillsEnabled?: boolean }>('/agent/config'),
        api<DynamicSkillCatalog>('/agent/skills'),
      ]);
      if (turn !== generation || ticket !== loading) return;
      enabled.value = config.dynamicSkillsEnabled === true;
      catalog.value = result;
    } catch (failure) {
      if (turn === generation && ticket === loading) error.value = (failure as Error).message;
    } finally {
      if (turn === generation && ticket === loading) busy.value = false;
    }
  }
  async function select(id: string) {
    const turn = generation;
    const ticket = ++selection;
    selectedId.value = id;
    detail.value = null;
    detailBusy.value = true;
    error.value = '';
    try {
      const result = await api<z.infer<typeof DynamicSkillDetailSchema>>(
        `/agent/skills/${encodeURIComponent(id)}`,
      );
      if (turn === generation && ticket === selection) detail.value = result;
    } catch (failure) {
      if (turn === generation && ticket === selection) error.value = (failure as Error).message;
    } finally {
      if (turn === generation && ticket === selection) detailBusy.value = false;
    }
  }
  async function mutate(path: string, method: 'POST' | 'PUT', payload: Record<string, unknown>) {
    if (!canWrite.value || busy.value) return false;
    const turn = generation;
    const body = { ...payload, expectedCatalogRevision: catalog.value.catalogRevision };
    const fingerprint = JSON.stringify({ path, method, body });
    const operationId = operations.get(fingerprint) ?? crypto.randomUUID();
    operations.set(fingerprint, operationId);
    busy.value = true;
    error.value = '';
    notice.value = '';
    try {
      const response = await api<{ skill: { skillId: string } }>(path, {
        method,
        body: { ...body, operationId },
      });
      if (turn !== generation) return false;
      operations.delete(fingerprint);
      const id = response.skill.skillId;
      await load();
      if (turn !== generation) return false;
      if (id) await select(id);
      notice.value = '技能目录已更新';
      return true;
    } catch (failure) {
      if (turn === generation) {
        const status = (failure as { status?: number }).status;
        error.value =
          status === 409 ? '目录已更新，请刷新后核对当前版本再操作。' : (failure as Error).message;
      }
      return false;
    } finally {
      if (turn === generation) busy.value = false;
    }
  }
  async function publish(candidate: unknown, skillId?: string) {
    const parsed = DynamicSkillDefinitionSchema.safeParse(candidate);
    if (!parsed.success) {
      error.value = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '定义'}：${issue.message}`)
        .join('；');
      return false;
    }
    return mutate('/agent/skills/publish', 'POST', {
      definition: parsed.data,
      ...(skillId ? { skillId } : {}),
    });
  }
  const setEnabled = (skillId: string, value: boolean) =>
    mutate(`/agent/skills/${encodeURIComponent(skillId)}/state`, 'PUT', { enabled: value });
  const activate = (skillId: string, version: string) =>
    mutate(
      `/agent/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(version)}/activate`,
      'POST',
      {},
    );
  const revoke = (skillId: string, version: string, reason: string) =>
    mutate(
      `/agent/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(version)}/revoke`,
      'POST',
      { reason },
    );
  return {
    catalog,
    detail,
    enabled,
    busy,
    detailBusy,
    error,
    notice,
    selectedId,
    canWrite,
    load,
    select,
    publish,
    setEnabled,
    activate,
    revoke,
  };
}

export function skillDefinitionText(definition: DynamicSkillDefinition) {
  return JSON.stringify(definition, null, 2);
}
