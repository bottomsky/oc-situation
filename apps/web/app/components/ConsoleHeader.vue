<script setup lang="ts">
import { roleLabel } from '../utils/display';
import {
  activeNavigationGroup,
  buildChartSearchLocation,
  navigationForRole,
} from '../utils/navigation';

const route = useRoute();
const { session, notice, logout } = usePlatform();
const header = useTemplateRef<HTMLElement>('header');
const groups = computed(() => navigationForRole(session.value?.user.role));
const activeGroup = computed(() => activeNavigationGroup(route.path, session.value?.user.role));
const openGroup = ref<string | null>(null);
const menuLeft = ref(20);
const currentMenu = computed(() => groups.value.find((group) => group.id === openGroup.value));
const searchInput = ref('');
const searchRevision = useState('chart-search-revision', () => 0);
const searching = ref(false);
const exiting = ref(false);
const clock = ref<Date | null>(null);
let clockTimer: ReturnType<typeof setInterval> | undefined;
let headerObserver: ResizeObserver | undefined;

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const dateText = computed(() =>
  clock.value ? dateFormatter.format(clock.value).replaceAll('/', '-') : '—',
);
const timeText = computed(() => (clock.value ? timeFormatter.format(clock.value) : '—'));

watch(
  () => route.query.q,
  (value) => {
    searchInput.value = typeof value === 'string' ? value : '';
  },
  { immediate: true },
);
watch(
  () => route.fullPath,
  () => {
    openGroup.value = null;
  },
);

async function submitSearch() {
  if (searching.value) return;
  const previousRevision = Number(route.query.searchRevision);
  searchRevision.value =
    Math.max(
      searchRevision.value,
      Number.isSafeInteger(previousRevision) && previousRevision >= 0 ? previousRevision : 0,
    ) + 1;
  searching.value = true;
  try {
    await navigateTo(buildChartSearchLocation(searchInput.value, searchRevision.value));
  } finally {
    searching.value = false;
  }
}

function closeMenu(restoreFocus = false) {
  const id = openGroup.value;
  openGroup.value = null;
  if (restoreFocus && id)
    header.value?.querySelector<HTMLButtonElement>(`[data-group="${id}"]`)?.focus();
}
async function toggleMenu(id: string) {
  if (openGroup.value === id) {
    closeMenu();
    return;
  }
  const trigger = header.value?.querySelector<HTMLButtonElement>(`[data-group="${id}"]`);
  if (header.value && trigger) {
    const bounds = header.value.getBoundingClientRect();
    menuLeft.value = Math.max(
      14,
      Math.min(trigger.getBoundingClientRect().left - bounds.left - 70, bounds.width - 236),
    );
  }
  openGroup.value = id;
  await nextTick();
  header.value?.querySelector<HTMLAnchorElement>('.navigation-menu a')?.focus();
}
function isInsideOpenNavigation(target: EventTarget | null) {
  if (!openGroup.value || !(target instanceof Node)) return false;
  const menu = header.value?.querySelector(`#navigation-menu-${openGroup.value}`);
  const trigger = header.value?.querySelector(`[data-group="${openGroup.value}"]`);
  return Boolean(menu?.contains(target) || trigger?.closest('.navigation-group')?.contains(target));
}
function closeOnBlur(event: FocusEvent) {
  if (!isInsideOpenNavigation(event.relatedTarget)) closeMenu();
}
function closeOutside(event: PointerEvent) {
  if (!isInsideOpenNavigation(event.target)) closeMenu();
}
async function exit() {
  if (exiting.value) return;
  exiting.value = true;
  try {
    await logout();
  } catch (error) {
    notice.value = (error as Error).message;
  } finally {
    exiting.value = false;
  }
}

onMounted(() => {
  clock.value = new Date();
  clockTimer = setInterval(() => {
    clock.value = new Date();
  }, 1000);
  document.addEventListener('pointerdown', closeOutside);
  const shell = header.value?.closest<HTMLElement>('.console-shell');
  const updateHeight = () => {
    if (header.value)
      shell?.style.setProperty(
        '--console-header-height',
        `${header.value.getBoundingClientRect().height}px`,
      );
  };
  updateHeight();
  headerObserver = new ResizeObserver(updateHeight);
  if (header.value) headerObserver.observe(header.value);
});
onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer);
  document.removeEventListener('pointerdown', closeOutside);
  headerObserver?.disconnect();
});
</script>

<template>
  <header
    ref="header"
    class="console-header"
    @keydown.esc="closeMenu(true)"
    @focusout="closeOnBlur"
  >
    <NuxtLink to="/" class="console-brand" aria-label="智能海图 · AIS 综合态势系统首页">
      <svg class="console-brand-mark" viewBox="0 0 40 40" fill="none" aria-hidden="true">
        <path
          d="M6 16a14 14 0 0 1 25-6l4 5H21l5-5M34 24A14 14 0 0 1 9 30l-4-5h14l-5 5"
          stroke="currentColor"
          stroke-width="4"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path d="m15 19 5-3 5 3-5 6-5-6Z" fill="currentColor" opacity=".55" />
      </svg>
      <span class="console-brand-copy"
        ><strong>智能海图 <span>·</span> AIS 综合态势系统</strong
        ><small>海上多元情报分析 / MARITIME INTELLIGENCE</small></span
      >
    </NuxtLink>

    <nav class="console-navigation" aria-label="主导航">
      <div
        v-for="group in groups"
        :key="group.id"
        class="navigation-group"
        :class="{ active: activeGroup === group.id }"
      >
        <NuxtLink
          :to="group.links[0]?.path ?? '/'"
          class="navigation-link"
          :aria-current="activeGroup === group.id ? 'location' : undefined"
          :title="group.links.map((link) => link.label).join(' / ')"
        >
          <ChartIcon :name="group.icon" class="navigation-icon" />
          <span>{{ group.label }}</span>
        </NuxtLink>
        <button
          :data-group="group.id"
          type="button"
          class="navigation-toggle"
          :aria-label="`展开${group.label}导航`"
          :aria-expanded="openGroup === group.id"
          :aria-controls="`navigation-menu-${group.id}`"
          @click="toggleMenu(group.id)"
          @keydown.down.prevent="toggleMenu(group.id)"
        >
          <ChartIcon name="ChevronDown" :size="12" />
        </button>
      </div>
    </nav>

    <form
      role="search"
      class="console-search"
      aria-label="全局船舶搜索"
      @submit.prevent="submitSearch"
    >
      <ChartIcon name="Search" :size="17" class="search-icon" />
      <input
        v-model="searchInput"
        aria-label="搜索船名、MMSI或IMO"
        placeholder="搜索船名 / MMSI / IMO"
        type="search"
        autocomplete="off"
      />
      <button type="submit" :disabled="searching" aria-label="搜索船舶" title="搜索船舶">
        <ChartIcon name="ArrowRight" :size="17" />
      </button>
    </form>

    <div class="console-utilities">
      <div class="console-clock" aria-label="北京时间">
        <span>{{ dateText }}</span
        ><span>{{ timeText }} <small>(UTC+8)</small></span>
      </div>
      <div class="console-identity">
        <svg class="identity-avatar" viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="16" cy="16" r="15" fill="#113d61" stroke="#4a88af" />
          <circle cx="16" cy="12" r="5" fill="#86c3eb" />
          <path d="M7 26a9 9 0 0 1 18 0" fill="#86c3eb" />
        </svg>
        <span class="identity-copy"
          ><strong :title="session?.user.username">{{ session?.user.username ?? '—' }}</strong
          ><small>{{ session ? roleLabel[session.user.role] : '' }}</small></span
        >
        <button type="button" :disabled="exiting" class="console-exit" @click="exit">
          {{ exiting ? '退出中' : '退出' }}
        </button>
      </div>
    </div>

    <div
      v-if="currentMenu"
      :id="`navigation-menu-${currentMenu.id}`"
      class="navigation-menu"
      :style="{ left: `${menuLeft}px` }"
    >
      <span class="navigation-menu-heading">{{ currentMenu.label }}</span>
      <NuxtLink
        v-for="link in currentMenu.links"
        :key="link.path"
        :to="link.path"
        :aria-current="route.path === link.path ? 'page' : undefined"
        :class="{ current: route.path === link.path }"
        @click="closeMenu()"
        >{{ link.label }}<ChartIcon name="ExternalLink" :size="13"
      /></NuxtLink>
    </div>
  </header>
</template>

<style scoped>
.console-header {
  --header-ink: #d9f0ff;
  --header-muted: #80a5be;
  position: relative;
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 18px;
  min-height: 76px;
  width: 100%;
  min-width: 0;
  padding: 0 20px;
  color: var(--header-ink);
  background: linear-gradient(110deg, #061b2c, #0b2841 52%, #051825);
  border-bottom: 1px solid #1374a0;
  box-shadow: 0 1px 12px #00b7e51c;
  font-family: 'Microsoft YaHei', 'Segoe UI', sans-serif;
}
.console-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  color: #c9f0ff;
}
.console-brand-mark {
  width: 39px;
  height: 39px;
  color: #05c5f2;
}
.console-brand-copy {
  display: grid;
  gap: 6px;
}
.console-brand-copy strong {
  font-size: 16px;
  font-weight: 700;
  white-space: nowrap;
  letter-spacing: 0.5px;
}
.console-brand-copy strong span {
  color: #64a9cb;
}
.console-brand-copy small {
  font-size: 8px;
  letter-spacing: 1.1px;
  color: var(--header-muted);
}
.console-navigation {
  display: flex;
  flex: 1 1 auto;
  align-self: stretch;
  overflow-x: auto;
  scrollbar-width: thin;
  scrollbar-color: #1a5873 transparent;
  min-width: 0;
}
.navigation-group {
  display: flex;
  position: relative;
  flex: 1 0 90px;
  min-width: 90px;
  border-left: 1px solid transparent;
  border-right: 1px solid transparent;
}
.navigation-group.active {
  background: linear-gradient(180deg, #0962a633, #006ebe66);
  border-color: #17648b;
  box-shadow: inset 0 -3px #1dccff;
}
.navigation-link {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #bad9ed;
  padding: 12px 5px;
  white-space: nowrap;
}
.navigation-link:hover,
.navigation-group.active .navigation-link {
  color: #e0faff;
}
.navigation-icon {
  width: 21px;
  height: 21px;
  color: #8fc9ed;
}
.navigation-group.active .navigation-icon {
  color: #5ed8ff;
  filter: drop-shadow(0 0 5px #07a6ff);
}
.navigation-toggle {
  display: grid;
  place-items: center;
  flex: 0 0 24px;
  width: 24px;
  padding: 0;
  color: #80bbd7;
  background: transparent;
  border: 0;
  border-radius: 0;
}
.navigation-toggle:hover {
  background: #127ab82b;
  color: #c1f5ff;
}
.console-search {
  display: flex;
  align-items: center;
  flex: 0 1 245px;
  min-width: 160px;
  border: 1px solid #285473;
  background: #061a2b;
  border-radius: 6px;
  height: 35px;
  color: #7cabc8;
}
.console-search:focus-within {
  border-color: #09c3ed;
  box-shadow: 0 0 0 2px #0ab6ed20;
}
.console-search input {
  min-width: 0;
  width: 100%;
  padding: 0 4px;
  background: transparent;
  border: 0;
  color: var(--header-ink);
  border-radius: 0;
  font-size: 11px;
  outline: none;
}
.console-search input::placeholder {
  color: #7198b4;
}
.console-search .search-icon {
  margin: 0 8px 0 10px;
  flex-shrink: 0;
}
.console-search button {
  display: grid;
  place-items: center;
  width: 30px;
  flex-shrink: 0;
  padding: 4px;
  background: transparent;
  color: #a2d6f0;
  border: 0;
  border-radius: 4px;
}
.console-search button:hover {
  color: #1bd1ff;
  background: #0b3c59;
}
.console-utilities {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-shrink: 0;
}
.console-clock {
  display: grid;
  gap: 5px;
  font:
    11px 'Consolas',
    monospace;
  padding-left: 15px;
  border-left: 1px solid #24495f;
  color: #bbd0e2;
  white-space: nowrap;
}
.console-clock small {
  font-size: 9px;
  color: var(--header-muted);
}
.console-identity {
  display: flex;
  align-items: center;
  gap: 7px;
}
.identity-avatar {
  width: 31px;
  height: 31px;
  flex-shrink: 0;
}
.identity-copy {
  display: grid;
  gap: 3px;
  max-width: 82px;
}
.identity-copy strong {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11px;
  white-space: nowrap;
  font-weight: 500;
}
.identity-copy small {
  color: var(--header-muted);
  font-size: 9px;
}
.console-exit {
  font-size: 10px;
  color: #8eb1c8;
  background: transparent;
  padding: 5px 3px;
  border: 0;
  white-space: nowrap;
}
.console-exit:hover {
  color: #dbf6ff;
}
.navigation-menu {
  position: absolute;
  top: calc(100% + 1px);
  left: 330px;
  min-width: 218px;
  max-width: calc(100% - 40px);
  background: #092338;
  border: 1px solid #21769c;
  padding: 9px;
  border-radius: 0 0 5px 5px;
  box-shadow: 0 12px 28px #00101999;
}
.navigation-menu-heading {
  display: block;
  color: #74a7c3;
  font-size: 10px;
  letter-spacing: 1px;
  padding: 5px 9px 8px;
}
.navigation-menu a {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 35px;
  font-size: 12px;
  padding: 11px 9px;
  border-radius: 3px;
  color: #c0e1f1;
}
.navigation-menu a.current {
  background: #0b4868;
  color: #7de6ff;
}
.navigation-menu a:hover {
  background: #123d58;
}
.navigation-menu a svg {
  color: #52a7ce;
}
.console-header :is(button, a):focus-visible {
  outline: 2px solid #35d5ff;
  outline-offset: -3px;
}
@media (max-width: 1439px) {
  .console-header {
    flex-wrap: wrap;
    gap: 12px 18px;
    padding-top: 13px;
  }
  .console-brand {
    margin-right: auto;
  }
  .console-search {
    flex-basis: 250px;
  }
  .console-navigation {
    order: 4;
    flex-basis: 100%;
    height: 61px;
  }
  .navigation-group {
    flex: 0 0 126px;
    min-width: 126px;
  }
  .navigation-link {
    flex-direction: row;
    gap: 8px;
    padding: 12px 13px;
  }
  .navigation-menu {
    left: 20px;
  }
}
@media (max-width: 820px) {
  .console-header {
    gap: 12px;
    padding: 12px 14px 0;
  }
  .console-brand {
    width: 100%;
  }
  .console-brand-copy strong {
    font-size: 16px;
  }
  .console-search {
    flex: 1 1 190px;
  }
  .console-utilities {
    gap: 10px;
  }
  .console-clock {
    padding-left: 0;
    border: 0;
  }
  .console-navigation {
    height: 52px;
    margin-top: 0;
  }
  .navigation-group {
    flex-basis: 118px;
    min-width: 118px;
  }
  .navigation-link {
    font-size: 11px;
    padding: 9px;
  }
  .navigation-icon {
    width: 18px;
    height: 18px;
  }
  .navigation-menu {
    left: 14px;
  }
}
@media (max-width: 520px) {
  .console-brand-copy strong {
    font-size: 15px;
    letter-spacing: 0;
  }
  .console-brand-copy small {
    font-size: 7px;
    letter-spacing: 0.6px;
  }
  .console-brand-mark {
    width: 33px;
    height: 33px;
  }
  .console-search {
    order: 3;
    flex-basis: 100%;
  }
  .console-utilities {
    justify-content: space-between;
    width: 100%;
  }
  .console-clock {
    display: flex;
    gap: 8px;
    font-size: 10px;
  }
  .identity-avatar {
    width: 26px;
    height: 26px;
  }
  .identity-copy strong {
    max-width: 67px;
  }
}
</style>
