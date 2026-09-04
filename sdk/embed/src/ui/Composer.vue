<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';

const props = defineProps<{
  disabled: boolean;
  running: boolean;
  quotedSelection: string | null;
  connectionError: boolean;
}>();

const emit = defineEmits<{
  send: [content: string];
  stop: [];
  clearSelection: [];
}>();

const text = ref('');
const inputEl = ref<HTMLTextAreaElement | null>(null);

function autoGrow() {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
}

watch(text, () => nextTick(autoGrow));

function onSend() {
  const content = text.value.trim();
  if (!content || props.disabled) return;
  emit('send', content);
  text.value = '';
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    onSend();
  }
}
</script>

<template>
  <div class="mao-composer">
    <div v-if="quotedSelection" class="mao-chip">
      <span>讨论：</span>
      <span class="mao-chip__text">{{ quotedSelection }}</span>
      <button class="mao-chip__close" type="button" aria-label="移除引用" @click="emit('clearSelection')">×</button>
    </div>
    <div class="mao-composer__row">
      <textarea
        ref="inputEl"
        v-model="text"
        class="mao-composer__input"
        rows="1"
        :disabled="disabled"
        :placeholder="disabled ? (running ? '执行中…' : '连接中…') : '输入消息，Enter 发送，Shift+Enter 换行'"
        @keydown="onKeydown"
      />
      <button v-if="running" class="mao-composer__stop" type="button" @click="emit('stop')">停止</button>
      <button v-else class="mao-composer__send" type="button" :disabled="disabled || !text.trim()" @click="onSend">
        <svg viewBox="0 0 24 24"><path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"/></svg>
      </button>
    </div>
    <div v-if="connectionError" class="mao-banner mao-banner--error" style="padding: 6px 0 0">
      连接已断开，发送时将自动重连
    </div>
  </div>
</template>
