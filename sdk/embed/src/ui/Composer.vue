<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { PageAuthorizationLevel } from '../page';
import PageAuthSwitcher from './PageAuthSwitcher.vue';

const props = defineProps<{
  running: boolean;
  quotedSelection: string | null;
  connectionError: boolean;
  pageAuthorization: PageAuthorizationLevel;
}>();

const emit = defineEmits<{
  send: [content: string];
  stop: [];
  clearSelection: [];
  setPageAuthorization: [level: PageAuthorizationLevel];
}>();

const text = ref('');
const inputEl = ref<HTMLTextAreaElement | null>(null);
const authEl = ref<InstanceType<typeof PageAuthSwitcher> | null>(null);

const canSend = computed(() => text.value.trim().length > 0 && !props.running);

function autoGrow() {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
}

watch(text, () => nextTick(autoGrow));

function onSend() {
  const content = text.value.trim();
  if (!content) return;
  // 执行中可继续打字，但不发出：embed 无消息队列，发出会被服务端拒绝并丢掉草稿
  if (props.running) return;
  emit('send', content);
  text.value = '';
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    onSend();
  }
}

/** 供 ChatPanel 在浮窗展开时调用 */
function focus() {
  inputEl.value?.focus();
}

function closeMenu() {
  authEl.value?.close();
}

function isMenuOpen() {
  return authEl.value?.isOpen() === true;
}

defineExpose({ focus, closeMenu, isMenuOpen });
</script>

<template>
  <div class="mao-composer">
    <div class="mao-composer__card">
      <div v-if="quotedSelection" class="mao-chip">
        <span class="mao-chip__label">讨论</span>
        <span class="mao-chip__text">{{ quotedSelection }}</span>
        <button class="mao-chip__close" type="button" aria-label="移除引用" @click="emit('clearSelection')">×</button>
      </div>
      <textarea
        ref="inputEl"
        v-model="text"
        class="mao-composer__input"
        rows="1"
        aria-label="消息输入框"
        placeholder="告诉 Agent 你想做什么..."
        @keydown="onKeydown"
      />
      <div class="mao-composer__toolbar">
        <PageAuthSwitcher
          ref="authEl"
          :level="pageAuthorization"
          @set-level="(level) => emit('setPageAuthorization', level)"
        />
        <button
          v-if="running"
          class="mao-composer__send mao-composer__stop"
          type="button"
          title="停止"
          aria-label="停止"
          @click="emit('stop')"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="2"/></svg>
        </button>
        <button
          v-else
          class="mao-composer__send"
          type="button"
          :class="{ 'mao-composer__send--active': canSend }"
          :disabled="!canSend"
          title="发送 (Enter)"
          aria-label="发送"
          @click="onSend"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 19V5M12 5 5 12M12 5l7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    </div>
    <div v-if="connectionError" class="mao-banner mao-banner--error mao-banner--inline">
      连接已断开，发送时将自动重连
    </div>
  </div>
</template>
