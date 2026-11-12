<template>
  <div class="tool-diff">
    <template v-for="(block, bi) in blocks" :key="bi">
      <div v-if="block.kind === 'gap'" class="diff-gap">⋯ {{ block.count }} 行未变化</div>
      <div
        v-for="(line, li) in block.kind === 'hunk' ? block.lines : []"
        :key="`${bi}-${li}`"
        class="diff-line"
        :class="`diff-line-${line.type}`"
      >
        <span class="diff-sign">{{
          line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '
        }}</span>
        <span class="diff-text">{{ line.text === '' ? ' ' : line.text }}</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { DiffBlock } from '../../utils/toolDiff'

defineProps<{
  blocks: DiffBlock[]
}>()
</script>

<style scoped>
.tool-diff {
  margin-bottom: 8px;
  padding: 6px 0;
  background: var(--aw-surface-code);
  border-radius: var(--aw-radius-sm);
  overflow-x: auto;
  max-height: 320px;
  overflow-y: auto;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-fine);
  line-height: 1.5;
}

.diff-line {
  display: flex;
  white-space: pre;
}

.diff-sign {
  flex-shrink: 0;
  width: 18px;
  padding-left: 6px;
  color: var(--aw-ink-muted-48);
  user-select: none;
}

.diff-text {
  color: var(--aw-text-code);
  padding-right: 12px;
}

.diff-line-add {
  background: color-mix(in srgb, var(--aw-success) 14%, transparent);
}

.diff-line-add .diff-sign {
  color: var(--aw-success);
}

.diff-line-del {
  background: color-mix(in srgb, var(--aw-danger) 14%, transparent);
}

.diff-line-del .diff-sign {
  color: var(--aw-danger);
}

.diff-gap {
  padding: 1px 0 1px 24px;
  color: var(--aw-ink-muted-48);
  background: var(--aw-canvas-parchment);
  font-size: var(--aw-text-fine);
}
</style>
