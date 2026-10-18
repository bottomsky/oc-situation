<script setup lang="ts">
import type { CurrentAgentReplyStatus } from '../composables/useAgentConversation';
defineProps<{ status: CurrentAgentReplyStatus }>();
const hidden = ref(false);
function visibility() {
  hidden.value = document.hidden;
}
onMounted(() => {
  visibility();
  document.addEventListener('visibilitychange', visibility);
});
onBeforeUnmount(() => document.removeEventListener('visibilitychange', visibility));
</script>
<template>
  <span
    class="holographic-avatar"
    :class="{ paused: hidden }"
    :data-state="status"
    aria-hidden="true"
  >
    <svg viewBox="0 0 64 72" fill="none">
      <ellipse cx="32" cy="66" rx="25" ry="4" stroke="currentColor" opacity=".45" />
      <path
        d="M14 60V54Q15 46 25 44L27 39M50 60V54Q49 46 39 44L37 39"
        stroke="currentColor"
        stroke-width="1.5"
        fill="currentColor"
        fill-opacity=".08"
      />
      <path
        d="M22 20Q22 10 32 10Q42 10 42 20L40 33Q38 41 32 42Q26 41 24 33Z"
        stroke="currentColor"
        stroke-width="1.6"
        fill="currentColor"
        fill-opacity=".12"
      />
      <path
        d="M22 22L32 18L42 22M26 28H29M35 28H38M30 35H34M25 44L32 51L39 44M32 51V61M17 55H47"
        stroke="currentColor"
        opacity=".8"
      />
      <path class="scan" d="M11 24H53" stroke="currentColor" opacity=".7" />
      <path d="M8 16V8H16M48 8H56V16M8 52V60H16M48 60H56V52" stroke="currentColor" opacity=".35" />
    </svg>
  </span>
</template>
<style scoped>
.holographic-avatar {
  display: block;
  width: 56px;
  height: 64px;
  flex: 0 0 56px;
  color: #6eeaff;
  filter: drop-shadow(0 0 5px #36aee666);
  animation: holo-breathe 4s ease-in-out infinite;
  overflow: hidden;
}
.holographic-avatar svg {
  width: 100%;
  height: 100%;
}
.scan {
  animation: holo-scan 5s linear infinite;
}
.holographic-avatar[data-state='failed'],
.holographic-avatar[data-state='send_failed'] {
  color: #ffb692;
}
.holographic-avatar[data-state='running'],
.holographic-avatar[data-state='waiting_result'] {
  animation-duration: 2.8s;
}
.paused,
.paused .scan {
  animation-play-state: paused;
}
@keyframes holo-breathe {
  0%,
  100% {
    opacity: 0.82;
  }
  45% {
    opacity: 1;
  }
  48% {
    opacity: 0.93;
  }
  51% {
    opacity: 1;
  }
}
@keyframes holo-scan {
  from {
    transform: translateY(-18px);
  }
  to {
    transform: translateY(40px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .holographic-avatar,
  .scan {
    animation: none;
  }
}
</style>
