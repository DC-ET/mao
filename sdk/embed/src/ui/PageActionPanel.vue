<script setup lang="ts">
import { computed } from 'vue';
import type { PageActionLogEntry, PageConfirmRequest } from '../page';

const props = defineProps<{
  confirm: PageConfirmRequest | null;
  logs: PageActionLogEntry[];
}>();

const emit = defineEmits<{
  confirm: [id: string, approved: boolean];
}>();

const riskLabel = computed(() => {
  if (props.confirm?.risk === 'high') return '高风险';
  if (props.confirm?.risk === 'sensitive') return '敏感数据';
  return '普通';
});

const recentLogs = computed(() => props.logs.slice(-5).reverse());
const visible = computed(() => props.confirm != null || recentLogs.value.length > 0);
</script>

<template>
  <div v-if="visible" class="mao-page">
    <div v-if="confirm" class="mao-page__confirm" role="alertdialog">
      <div class="mao-page__confirm-head">
        <span class="mao-page__risk" :data-risk="confirm.risk">{{ riskLabel }}</span>
        <span class="mao-page__confirm-title">Agent 请求执行页面操作</span>
      </div>
      <p class="mao-page__confirm-text">{{ confirm.summary }}</p>
      <p v-if="confirm.element?.label" class="mao-page__confirm-target">目标元素：{{ confirm.element.label }}</p>
      <div class="mao-page__confirm-actions">
        <button class="mao-page__chip" type="button" @click="emit('confirm', confirm.id, false)">拒绝</button>
        <button class="mao-page__chip mao-page__chip--strong" type="button" @click="emit('confirm', confirm.id, true)">允许本次</button>
      </div>
    </div>

    <p v-if="recentLogs.length" class="mao-page__logs-title">正在操作当前页面</p>
    <ul v-if="recentLogs.length" class="mao-page__logs">
      <li v-for="log in recentLogs" :key="log.id" :data-status="log.status">
        <span class="mao-page__log-dot" :data-status="log.status" />
        {{ log.summary }}
      </li>
    </ul>
  </div>
</template>
