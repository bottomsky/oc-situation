<script setup lang="ts">
import type { UserRole } from '@ais/contracts';
import { roleLabel } from '../utils/display';
interface User {
  id: string;
  username: string;
  role: UserRole;
  disabled: boolean;
}
const { session } = usePlatform();
const { data, busy, error, load, mutate } = useResource<User[]>('/users', []);
const editor = ref(false);
const selected = ref<User | null>(null);
const username = ref('');
const password = ref('');
const role = ref<UserRole>('viewer');
const disabled = ref(false);
function open(u?: User) {
  selected.value = u ?? null;
  username.value = u?.username ?? '';
  password.value = '';
  role.value = u?.role ?? 'viewer';
  disabled.value = u?.disabled ?? false;
  editor.value = true;
}
async function save() {
  const body = selected.value
    ? {
        role: role.value,
        disabled: disabled.value,
        ...(password.value ? { password: password.value } : {}),
      }
    : { username: username.value, password: password.value, role: role.value };
  if (
    await mutate(
      selected.value ? '/users/' + selected.value.id : '/users',
      selected.value ? 'PUT' : 'POST',
      body,
    )
  ) {
    password.value = '';
    editor.value = false;
  }
}
useUiComponent('page.list', { read: () => uiProjection(true, [], { loading: busy.value }) });
useUiReadOnlyEditor(
  () => editor.value,
  () => ({
    username: username.value,
    password: password.value,
    role: role.value,
    disabled: disabled.value,
  }),
  () => busy.value,
);
</script>
<template>
  <section class="page">
    <div class="page-heading">
      <div>
        <div class="eyebrow">TEAM ACCESS</div>
        <h1>账号权限</h1>
        <p>管理员配置来源与账号，操作员执行任务，只读用户查询观测。</p>
      </div>
      <button @click="open()">新增账号</button>
    </div>
    <FetchState :busy="busy" :error="error" @retry="load" />
    <form v-if="editor" class="panel editor-grid" @submit.prevent="save">
      <h2 class="wide">{{ selected ? '管理账号' : '新增账号' }}</h2>
      <label
        >用户名<input
          v-model="username"
          :readonly="!!selected"
          required
          autocomplete="off" /></label
      ><label
        >{{ selected ? '新密码（留空保持原值）' : '初始密码'
        }}<input
          v-model="password"
          type="password"
          :required="!selected"
          minlength="12"
          autocomplete="new-password" /></label
      ><label
        >角色<select v-model="role">
          <option value="viewer">只读用户</option>
          <option value="operator">操作员</option>
          <option value="admin">管理员</option>
        </select></label
      ><label v-if="selected"
        ><span><input v-model="disabled" type="checkbox" /> 停用账号</span></label
      >
      <p class="wide muted">密码至少 12 个字符。调整权限或密码后，该账号会话立即失效。</p>
      <div class="wide actions">
        <button :disabled="busy">保存账号</button
        ><button type="button" @click="editor = false">取消</button>
      </div>
    </form>
    <div class="panel">
      <table>
        <thead>
          <tr>
            <th>用户</th>
            <th>角色</th>
            <th>状态</th>
            <th>管理</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in data" :key="u.id">
            <td>
              {{ u.username }}<span v-if="u.id === session?.user.id" class="badge">当前账号</span>
            </td>
            <td>{{ roleLabel[u.role] }}</td>
            <td>{{ u.disabled ? '已停用' : '有效' }}</td>
            <td><button @click="open(u)">编辑权限</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
