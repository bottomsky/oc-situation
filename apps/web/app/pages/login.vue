<script setup lang="ts">
import type { Session } from '../composables/usePlatform';
const { api, session } = usePlatform();
const username = ref('');
const password = ref('');
const busy = ref(false);
const error = ref('');
async function login() {
  busy.value = true;
  error.value = '';
  try {
    session.value = await api<Session>('/auth/login', {
      method: 'POST',
      body: { username: username.value, password: password.value },
    });
    password.value = '';
    await navigateTo('/');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="login-scene">
    <div class="login-intro">
      <span class="eyebrow">MARITIME INTELLIGENCE</span>
      <h1>海上的每一次报告，<br />都有迹可循。</h1>
      <p>船位观测 · 历史轨迹 · 采集治理</p>
      <div class="login-coordinates">WGS84 / UTC / AIS</div>
    </div>
    <form class="login-form" @submit.prevent="login">
      <div class="eyebrow">团队工作空间</div>
      <h2>登录海图</h2>
      <p class="muted">使用管理员分配的账号进入。</p>
      <label
        >用户名<input
          v-model="username"
          name="username"
          autocomplete="username"
          required
          autofocus /></label
      ><label
        >密码<input
          v-model="password"
          name="password"
          type="password"
          autocomplete="current-password"
          required
      /></label>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <UButton type="submit" :loading="busy" block>进入工作空间 →</UButton>
      <p class="login-footnote">内部协作平台 · 会话有效期 8 小时</p>
    </form>
  </section>
</template>
