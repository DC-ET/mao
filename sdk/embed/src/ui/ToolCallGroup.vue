<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ToolCallItem } from '../types';
import MaoIcon from './MaoIcon.vue';
import ToolCallElapsed from './ToolCallElapsed.vue';
import ToolCallRow from './ToolCallRow.vue';
import { ICON_ARROW_DOWN, getToolIconDef } from './icons';
import { getToolDisplayName } from './toolDisplay';

/**
 * 工具调用组（对齐 desktop ToolCallGroup）：
 * 单调用直接渲染卡片行（行头即组壳，一次点击即展开）；多调用先给组头——
 * 「图标 + N次中文名汇总」+ 组内执行耗时与转圈，展开后逐张卡片行。
 */
const props = defineProps<{ toolCalls: ToolCallItem[] }>();

const isExpanded = ref(false);

const hasRunning = computed(() =>
  props.toolCalls.some((tc) => tc.status === 'running'));

/**
 * 组头耗时：取组内仍在执行、最早开始的那个调用（已结束的不参与——它们的耗时到
 * 结果事件即停，不该继续撑住组头）。无 running 调用或无起表时刻时为 null。
 */
const runningStartedAtMs = computed(() => {
  let earliest: number | null = null;
  for (const tc of props.toolCalls) {
    if (tc.status !== 'running') continue;
    if (tc.startedAtMs == null) continue;
    if (earliest == null || tc.startedAtMs < earliest) earliest = tc.startedAtMs;
  }
  return earliest;
});

const groupIcon = computed(() => getToolIconDef(props.toolCalls[0]?.toolName ?? ''));

const groupSummary = computed(() => {
  const tools = props.toolCalls;
  if (tools.length === 0) return '';
  if (tools.length === 1 && tools[0].summary) return tools[0].summary;

  const toolCounts = new Map<string, number>();
  for (const tc of tools) {
    const name = tc.toolName;
    toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
  }

  const parts: string[] = [];
  for (const [name, count] of toolCounts) {
    const displayName = getToolDisplayName(name);
    parts.push(count > 1 ? `${count}次${displayName}` : displayName);
  }

  return parts.join('、');
});

function toggleExpand() {
  isExpanded.value = !isExpanded.value;
}
</script>

<template>
  <div class="mao-toolgroup">
    <!-- 单调用：卡片行头充当组壳（与多调用组头同口径的点击热区/悬停反馈/图标） -->
    <ToolCallRow v-if="toolCalls.length === 1" :tool-call="toolCalls[0]" standalone />
    <template v-else>
      <button type="button" class="mao-toolgroup__header" :aria-expanded="isExpanded" @click="toggleExpand">
        <span class="mao-toolgroup__info">
          <MaoIcon :icon="groupIcon" :size="14" class="mao-toolgroup__icon" />
          <span class="mao-toolgroup__summary">{{ groupSummary }}</span>
        </span>
        <span class="mao-toolgroup__status">
          <ToolCallElapsed v-if="runningStartedAtMs != null" :started-at-ms="runningStartedAtMs" />
          <span v-if="hasRunning" class="mao-spinner" aria-hidden="true" />
          <MaoIcon
            :icon="ICON_ARROW_DOWN"
            :size="12"
            class="mao-chevron"
            :class="{ 'mao-chevron--open': isExpanded }"
          />
        </span>
      </button>
      <div v-if="isExpanded" class="mao-toolgroup__body">
        <ToolCallRow v-for="tc in toolCalls" :key="tc.toolCallId" :tool-call="tc" />
      </div>
    </template>
  </div>
</template>
