<template>
  <div class="call-prompt">
    <template v-if="bothEmpty">
      <div class="prompt-empty">该调用未记录请求构成（历史行）</div>
    </template>
    <template v-else>
      <div class="prompt-section">
        <div class="prompt-section-head">
          <span class="prompt-section-label">工具清单</span>
          <span v-if="toolsNote" class="prompt-note">{{ toolsNote }}</span>
        </div>
        <div v-if="toolNames.length > 0" class="prompt-tools">
          <span v-for="name in toolNames" :key="name" class="prompt-tool-chip">{{ name }}</span>
        </div>
        <pre v-else-if="toolsRaw != null" class="prompt-pre">{{ toolsRaw }}</pre>
      </div>
      <div class="prompt-section">
        <div class="prompt-section-head">
          <span class="prompt-section-label">系统提示词</span>
          <span v-if="truncated" class="prompt-truncated" :title="truncationHint">已截断</span>
          <button
            type="button"
            class="prompt-wrap-btn"
            :class="{ active: wrap }"
            title="长行自动换行 / 按原样不换行"
            @click="wrap = !wrap"
          >{{ wrap ? '换行' : '原样' }}</button>
        </div>
        <pre v-if="call.systemPrompt != null" class="prompt-pre" :class="{ nowrap: !wrap }">{{ call.systemPrompt }}</pre>
        <div v-else class="prompt-empty">未记录系统提示词（历史行 / 无 system 消息）</div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TraceCallMeta } from '../../types/trace'

/**
 * 「请求构成」tab（技术方案 2026-10-25-run-trace-content-and-prompt §5.6）：
 * 工具抽屉与轮次抽屉共用——两处配对到的是同一行 llm_call，口径必须一致。
 * 系统提示词是模板文本，按原样 <pre> 展示不做 markdown 渲染（渲染会破坏模板结构
 * 的可读性）；工具清单解析成功显示 chips，解析失败按原样文本展示，不报错。
 */

const props = defineProps<{
  call: TraceCallMeta
}>()

const wrap = ref(true)

const TRUNCATION_SUFFIX = /…\[已截断，原长 \d+ 字符\]$/

const toolsRaw = computed(() => props.call.toolsJson)
const truncated = computed(() => props.call.systemPrompt != null && TRUNCATION_SUFFIX.test(props.call.systemPrompt))
const truncationHint = computed(() => {
  const match = TRUNCATION_SUFFIX.exec(props.call.systemPrompt ?? '')
  return match != null ? `超过采集上限被截断（${match[0].slice(1)}）` : ''
})

const bothEmpty = computed(() => props.call.systemPrompt == null && props.call.toolsJson == null)

const toolNames = computed<string[]>(() => {
  if (props.call.toolsJson == null) return []
  try {
    const parsed: unknown = JSON.parse(props.call.toolsJson)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((name): name is string => typeof name === 'string' && name !== '')
  } catch {
    return []
  }
})

/** 工具清单侧的说明：未记录（历史行）/ N 个；解析失败不写说明，原样文本自明。 */
const toolsNote = computed(() => {
  if (props.call.toolsJson == null) return '未记录（历史行 / 无工具）'
  return toolNames.value.length > 0 ? `${toolNames.value.length} 个` : ''
})
</script>

<style scoped>
.call-prompt {
  display: flex;
  flex-direction: column;
  gap: var(--aw-space-xxs);
}

.prompt-empty {
  color: var(--aw-ink-muted-40);
  font-size: var(--aw-text-micro);
  padding: 2px 0;
}

.prompt-section {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.prompt-section-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.prompt-section-label {
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-64);
  font-weight: 600;
}

.prompt-note {
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-40);
}

.prompt-truncated {
  font-size: var(--aw-text-micro);
  color: var(--aw-status-waiting);
  cursor: help;
}

.prompt-wrap-btn {
  margin-left: auto;
  font-size: var(--aw-text-micro);
  height: 18px;
  padding: 0 6px;
  border-radius: var(--aw-radius-xs);
  border: 1px solid var(--aw-hairline);
  background: var(--aw-surface);
  color: var(--aw-ink-muted-64);
  cursor: pointer;
}

.prompt-wrap-btn.active {
  color: var(--aw-primary);
  border-color: var(--aw-primary-line);
  background: var(--aw-primary-hover);
}

.prompt-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}

.prompt-tool-chip {
  font-size: var(--aw-text-micro);
  font-family: var(--aw-font-mono);
  padding: 1px 5px;
  border-radius: var(--aw-radius-xs);
  background: rgba(0, 0, 0, 0.05);
  color: var(--aw-ink-muted-64);
}

[data-theme="dark"] .prompt-tool-chip {
  background: rgba(255, 255, 255, 0.08);
}

.prompt-pre {
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
  max-height: 60vh;
  overflow: auto;
}

.prompt-pre.nowrap {
  white-space: pre;
  word-break: normal;
}
</style>
