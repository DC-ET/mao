<template>
  <div class="terminal-copy-overlay">
    <div class="terminal-copy-bar">
      <span class="terminal-copy-title">
        选择文本（快照，进入后新输出不会更新）
        <span v-if="alternate" class="terminal-copy-hint">· 全屏程序只能复制当前一屏</span>
      </span>
      <button type="button" class="terminal-copy-btn" aria-label="复制全部快照文本" @click="$emit('copy', text)">复制全部</button>
      <button type="button" class="terminal-copy-btn" aria-label="关闭选择文本" @click="$emit('close')">完成</button>
    </div>
    <pre
      ref="contentRef"
      class="terminal-copy-content"
      :style="contentStyle"
    >{{ text }}</pre>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

const props = defineProps<{
  text: string
  fontFamily: string
  fontSize: number
  lineHeight: number
  letterSpacing: number
  initialScrollTop: number
  /** 备用缓冲区（vim / less）：只有当前一屏，没有 scrollback。 */
  alternate?: boolean
}>()

defineEmits<{
  copy: [text: string]
  close: []
}>()

const contentRef = ref<HTMLElement | null>(null)

const contentStyle = computed(() => ({
  fontFamily: props.fontFamily,
  fontSize: `${props.fontSize}px`,
  lineHeight: String(props.lineHeight),
  letterSpacing: `${props.letterSpacing}px`,
}))

onMounted(() => {
  const el = contentRef.value
  if (el) el.scrollTop = props.initialScrollTop
})
</script>

<style scoped>
.terminal-copy-overlay {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  background: var(--aw-terminal-bg);
  color: var(--aw-ink);
}

.terminal-copy-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 6px 10px;
  border-bottom: 1px solid var(--aw-divider-soft);
  background: var(--aw-terminal-header-bg);
}

.terminal-copy-title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--aw-ink-muted-60);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.terminal-copy-hint {
  color: var(--aw-ink-muted-40);
}

.terminal-copy-btn {
  flex-shrink: 0;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--aw-divider-soft);
  border-radius: 6px;
  background: var(--aw-canvas);
  color: var(--aw-ink);
  font-size: 12px;
  cursor: pointer;
}

.terminal-copy-content {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 8px 10px 16px;
  overflow: auto;
  white-space: pre;
  color: var(--aw-ink);
  user-select: text;
  -webkit-user-select: text;
  touch-action: pan-y;
  -webkit-text-size-adjust: 100%;
}
</style>