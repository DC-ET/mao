<template>
  <!-- ask_user_questions 已回答回放视图：问题 → 选中标签 chip → 自定义输入引用块。
       等待回复态由 QuestionPanel 覆盖，回答落库后回到工具卡片靠本视图回放。 -->
  <div class="tool-ask-user">
    <div v-for="(pair, i) in view" :key="i" class="qa-group">
      <div class="question-text">{{ pair.question }}</div>
      <div v-if="pair.labels.length > 0" class="chip-row">
        <span v-for="label in pair.labels" :key="label" class="answer-chip">{{ label }}</span>
      </div>
      <div v-if="pair.customInput" class="custom-input-block">{{ pair.customInput }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { AskUserPair } from '../../utils/toolRichView'

defineProps<{
  view: AskUserPair[]
}>()
</script>

<style scoped>
.tool-ask-user {
  margin-bottom: 8px;
}

.qa-group {
  padding: 4px 0;
}

.qa-group + .qa-group {
  border-top: 1px solid var(--aw-divider-soft);
}

.question-text {
  margin-bottom: 4px;
  font-size: 13px;
  color: var(--aw-ink);
  line-height: 1.4;
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

/* chip 样式对齐 QuestionPanel 的 question-tag：primary 10% 底 + primary 文字 */
.answer-chip {
  display: inline-block;
  padding: 1px 8px;
  border-radius: var(--aw-radius-xs);
  background: color-mix(in srgb, var(--aw-primary) 10%, transparent);
  color: var(--aw-primary);
  font-size: var(--aw-text-fine);
  font-weight: 600;
}

.custom-input-block {
  margin-top: 4px;
  padding: 2px 0 2px 8px;
  border-left: 2px solid var(--aw-primary);
  font-size: var(--aw-text-caption);
  color: var(--aw-text-secondary, #8e8e93);
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
