<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { PageAuthorizationLevel } from '../page';

const LEVELS: Array<{ id: PageAuthorizationLevel; label: string; desc: string }> = [
  { id: 'per_action', label: '每次确认', desc: '每个写操作前在浮窗确认' },
  { id: 'task', label: '本次任务授权', desc: '本次任务内自动执行，任务结束失效' },
  { id: 'full', label: '完全授权', desc: '本站自动执行，刷新后仍有效' },
];

const props = defineProps<{
  level: PageAuthorizationLevel;
}>();

const emit = defineEmits<{
  setLevel: [level: PageAuthorizationLevel];
}>();

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);

const current = computed(() => LEVELS.find((item) => item.id === props.level) ?? LEVELS[0]);

function toggle() {
  open.value = !open.value;
}

function close() {
  open.value = false;
}

function select(level: PageAuthorizationLevel) {
  open.value = false;
  if (level !== props.level) emit('setLevel', level);
}

function onDocPointerDown(e: PointerEvent) {
  const path = e.composedPath();
  if (rootEl.value && !path.includes(rootEl.value)) open.value = false;
}

onMounted(() => document.addEventListener('pointerdown', onDocPointerDown, true));
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointerDown, true));

defineExpose({ isOpen: () => open.value, close });
</script>

<template>
  <div ref="rootEl" class="mao-auth">
    <button
      class="mao-auth__badge"
      type="button"
      :data-level="level"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-label="`页面操作授权：${current.label}`"
      @click="toggle"
    >
      <svg class="mao-auth__icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4Zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8Z"/>
      </svg>
      {{ current.label }}
      <svg class="mao-auth__chevron" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41Z"/>
      </svg>
    </button>
    <div v-if="open" class="mao-auth__menu" role="listbox" :aria-label="`当前 ${current.label}`">
      <button
        v-for="item in LEVELS"
        :key="item.id"
        class="mao-auth__option"
        type="button"
        role="option"
        :aria-selected="item.id === level"
        :data-level="item.id"
        @click="select(item.id)"
      >
        <span class="mao-auth__name">{{ item.label }}</span>
        <span class="mao-auth__desc">{{ item.desc }}</span>
      </button>
    </div>
  </div>
</template>
