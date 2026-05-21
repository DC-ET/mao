<template>
  <div class="progress-checklist">
    <div v-if="!steps || steps.length === 0" class="progress-empty">
      执行步骤将在任务开始后显示
    </div>
    <div v-else class="step-list">
      <div v-for="step in steps" :key="step.id" class="step-item" :class="{ done: step.done }">
        <el-icon class="step-check" :size="14">
          <Select v-if="step.done" />
          <span v-else class="step-pending"></span>
        </el-icon>
        <span class="step-label">{{ step.label }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Select } from '@element-plus/icons-vue'

defineProps<{
  steps?: Array<{ id: string; label: string; done: boolean }>
}>()
</script>

<style scoped>
.progress-checklist {
  padding: 8px 0;
}

.progress-empty {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
  padding: 8px 0;
}

.step-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.step-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-80);
  letter-spacing: -0.224px;
}

.step-item.done {
  color: var(--aw-ink-muted-48);
}

.step-check {
  flex-shrink: 0;
  color: var(--aw-success);
}

.step-pending {
  width: 14px;
  height: 14px;
  border: 1.5px solid var(--aw-hairline);
  border-radius: 50%;
  display: inline-block;
}

.step-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.step-item.done .step-label {
  text-decoration: line-through;
}
</style>
