<template>
  <div class="call-meta">
    <dl class="meta-grid">
      <div v-for="row in rows" :key="row.label" class="meta-row">
        <dt class="meta-key">{{ row.label }}</dt>
        <dd class="meta-val" :class="{ 'meta-danger': row.danger }">{{ row.value }}</dd>
      </div>
    </dl>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { llmCallSceneLabel, llmCallProtocolLabel } from '../../utils/llmCallLabels'
import { decodingMs, formatThroughput } from '../../utils/trace-display'
import type { TraceCallMeta } from '../../types/trace'

/**
 * 调用元信息表格（技术方案 2026-10-22-run-trace-deep-dive §5.6）：
 * llm_call 全字段 + 派生三行（解码耗时 / 吞吐量 / 请求编号）。
 * 派生量与轮次行读同一组纯函数，避免「两处各算一遍」对不上。
 */

const props = defineProps<{
  call: TraceCallMeta
}>()

const rows = computed(() => {
  const c = props.call
  const decode = decodingMs({ durationMs: c.durationMs, firstTokenMs: c.firstTokenMs })
  const speed = formatThroughput({ durationMs: c.durationMs, firstTokenMs: c.firstTokenMs, completionTokens: c.completionTokens })
  return [
    { label: '请求编号', value: c.llmCallId == null ? '—' : `#${c.llmCallId}` },
    { label: 'provider', value: c.provider ?? '—' },
    { label: 'protocol', value: llmCallProtocolLabel(c.protocol) },
    { label: 'stream', value: c.stream == null ? '—' : (c.stream ? '流式' : '非流式') },
    { label: 'effort', value: c.effort ?? '—' },
    { label: 'scene', value: c.scene == null ? '—' : llmCallSceneLabel(c.scene) },
    { label: '模型', value: c.modelName ?? '—' },
    { label: '总耗时', value: formatMs(c.durationMs) },
    { label: '首字耗时', value: c.firstTokenMs == null ? '—' : formatMs(c.firstTokenMs) },
    { label: '解码耗时', value: decode == null ? '—' : formatMs(decode) },
    { label: '吞吐量', value: speed },
    { label: '输入 tokens', value: formatTokens(c.promptTokens) },
    { label: '缓存读 tokens', value: formatTokens(c.cachedTokens) },
    { label: '缓存写 tokens', value: formatTokens(c.cacheCreationTokens) },
    { label: '输出 tokens', value: formatTokens(c.completionTokens) },
    { label: '成本', value: c.costMicros == null ? '—' : formatCost(c.costMicros) },
    { label: '重试次数', value: String(c.retryCount) },
    { label: '调用时刻', value: c.createdAt ?? '—' },
    { label: '错误信息', value: c.errorMessage ?? '—', danger: c.errorMessage != null },
  ]
})

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

function formatTokens(tokens: number): string {
  return tokens.toLocaleString('zh-CN')
}

function formatCost(costMicros: number): string {
  return (costMicros / 1_000_000).toLocaleString('zh-CN', { maximumFractionDigits: 3 })
}
</script>

<style scoped>
.meta-grid {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.meta-row {
  display: flex;
  align-items: baseline;
  gap: var(--aw-space-xxs);
  padding: 2px 0;
  border-bottom: 1px solid var(--aw-divider-soft);
}

.meta-key {
  flex-shrink: 0;
  width: 110px;
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-40);
}

.meta-val {
  margin: 0;
  flex: 1;
  min-width: 0;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-micro);
  color: var(--aw-ink);
  word-break: break-all;
}

.meta-val.meta-danger {
  color: var(--aw-danger);
}
</style>
