<template>
  <div class="json-text">
    <div v-if="raw == null || raw === ''" class="json-empty">{{ emptyText }}</div>
    <template v-else>
      <div class="json-toolbar">
        <button
          type="button"
          class="json-mode-btn"
          :class="{ active: pretty && isJson }"
          :disabled="!isJson"
          :title="isJson ? '格式化展示' : '不是合法 JSON，只能按原样展示'"
          @click="pretty = true"
        >格式化</button>
        <button
          type="button"
          class="json-mode-btn"
          :class="{ active: !pretty }"
          title="按服务端存储的原文展示"
          @click="pretty = false"
        >原样</button>
        <span v-if="!isJson" class="json-note">非 JSON 文本，按原样展示</span>
      </div>
      <pre class="json-pre">{{ display }}</pre>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

/**
 * 参数 / 结果原文展示（技术方案 2026-10-22-run-trace-deep-dive §5.6）。
 * 不引 JSON 树库：抽屉是排障视图，原样文本最利于复制比对；树形折叠在深嵌套大对象上
 * 反而更难定位。非法 JSON 按原样展示，不报错、不显示「解析失败」红字——多模态
 * 结果（图片分片数组）与纯文本结果都要能看。
 */

const props = defineProps<{
  raw: string | null
  emptyText: string
}>()

const pretty = ref(true)

const isJson = computed(() => {
  if (props.raw == null || props.raw.trim() === '') return false
  try {
    JSON.parse(props.raw)
    return true
  } catch {
    return false
  }
})

const display = computed(() => {
  if (props.raw == null) return ''
  if (!pretty.value || !isJson.value) return props.raw
  try {
    return JSON.stringify(JSON.parse(props.raw), null, 2)
  } catch {
    return props.raw
  }
})
</script>

<style scoped>
.json-text {
  display: flex;
  flex-direction: column;
  gap: var(--aw-space-xxs);
}

.json-empty {
  color: var(--aw-ink-muted-40);
  padding: var(--aw-space-xs) 0;
}

.json-toolbar {
  display: flex;
  align-items: center;
  gap: 3px;
}

.json-mode-btn {
  font-size: var(--aw-text-micro);
  font-family: var(--aw-font-text);
  height: 18px;
  padding: 0 6px;
  border-radius: var(--aw-radius-xs);
  border: 1px solid var(--aw-hairline);
  background: var(--aw-surface);
  color: var(--aw-ink-muted-64);
  cursor: pointer;
}

.json-mode-btn.active:not(:disabled) {
  color: var(--aw-primary);
  border-color: var(--aw-primary-line);
  background: var(--aw-primary-hover);
}

.json-mode-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.json-note {
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-40);
}

.json-pre {
  margin: 0;
  padding: var(--aw-space-xxs);
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-xs);
  background: var(--aw-surface-pearl);
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-micro);
  line-height: 1.5;
  color: var(--aw-ink);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 100%;
  overflow: auto;
}
</style>
