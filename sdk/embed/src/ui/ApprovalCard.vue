<script setup lang="ts">
import type { PendingApproval } from '../types';

defineProps<{ approval: PendingApproval }>();
const emit = defineEmits<{ decide: [requestId: string, approved: boolean] }>();
</script>

<template>
  <div class="mao-card">
    <div class="mao-card__title">工具执行请求</div>
    <div>
      Agent 请求执行 <strong>{{ approval.toolName }}</strong>
    </div>
    <div v-if="approval.summary" class="mao-toolcard__args">{{ approval.summary }}</div>
    <div v-if="approval.dangerReason" class="mao-card__danger">⚠ {{ approval.dangerReason }}</div>
    <div class="mao-card__actions">
      <button class="mao-btn mao-btn--ghost" type="button" @click="emit('decide', approval.requestId, false)">
        拒绝
      </button>
      <button class="mao-btn mao-btn--primary" type="button" @click="emit('decide', approval.requestId, true)">
        允许
      </button>
    </div>
  </div>
</template>
