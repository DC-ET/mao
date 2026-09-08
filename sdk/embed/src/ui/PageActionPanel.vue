<script setup lang="ts">
import { computed } from 'vue';
import type { PageActionLogEntry, PageAuthorizationLevel, PageConfirmRequest } from '../page';

const props = defineProps<{
  level: PageAuthorizationLevel;
  taskActive: boolean;
  confirm: PageConfirmRequest | null;
  logs: PageActionLogEntry[];
}>();

const emit = defineEmits<{
  setLevel: [level: PageAuthorizationLevel];
  confirm: [id: string, approved: boolean];
  cancelTask: [];
}>();

const levelLabel = computed(() => {
  if (props.level === 'full') return '完全授权';
  if (props.level === 'task') return '本次任务授权';
  return '每次确认';
});

const riskLabel = computed(() => {
  if (props.confirm?.risk === 'high') return '高风险';
  if (props.confirm?.risk === 'sensitive') return '敏感数据';
  return '普通';
});

const recentLogs = computed(() => props.logs.slice(-5).reverse());
</script>

<template>
  <div class="mao-page">
    <div class="mao-page__bar">
      <span class="mao-page__level" :data-level="level">页面操作：{{ levelLabel }}</span>
      <span class="mao-page__spacer" />
      <button v-if="level !== 'per_action'" class="mao-page__chip" type="button" @click="emit('setLevel', 'per_action')">改为每次确认</button>
      <button v-if="level !== 'task'" class="mao-page__chip" type="button" @click="emit('setLevel', 'task')">本次任务授权</button>
      <button v-if="level !== 'full'" class="mao-page__chip mao-page__chip--strong" type="button" @click="emit('setLevel', 'full')">完全授权</button>
      <button v-if="taskActive" class="mao-page__chip mao-page__chip--danger" type="button" @click="emit('cancelTask')">停止页面任务</button>
    </div>

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

    <ul v-if="recentLogs.length" class="mao-page__logs">
      <li v-for="log in recentLogs" :key="log.id" :data-status="log.status">
        <span class="mao-page__log-dot" :data-status="log.status" />
        {{ log.summary }}
      </li>
    </ul>
  </div>
</template>
