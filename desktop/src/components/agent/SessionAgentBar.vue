<template>
  <div v-if="visible" class="session-agent-bar">
    <!-- 会话切换/历史加载中：只占位，绝不显示上一个会话的 Agent -->
    <div v-if="!ready" class="bar-skeleton" aria-busy="true">
      <span class="sk-avatar" />
      <span class="sk-line" />
    </div>
    <template v-else>
      <button type="button" class="bar-main" :title="tooltip" @click="emit('open-detail')">
        <AgentAvatar :name="identity.name" :avatar-url="identity.avatarUrl" :size="22" />
        <span class="bar-name">{{ identity.name }}</span>
        <span v-if="identity.description" class="bar-desc">{{ identity.description }}</span>
        <span v-if="!identity.resolved" class="bar-hint">已停用或不可见</span>
      </button>
      <button type="button" class="bar-detail" @click="emit('open-detail')">
        <span class="detail-long">查看智能体</span>
        <span class="detail-short">详情</span>
      </button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAgentStore } from '../../stores/agent'
import { resolveAgentIdentity } from '../../utils/agent-identity'
import AgentAvatar from './AgentAvatar.vue'

const props = withDefaults(
  defineProps<{
    agentId?: string | null
    agentName?: string | null
    sessionId?: string | null
    activeSessionId?: string | null
    loading?: boolean
  }>(),
  {
    agentId: null,
    agentName: null,
    sessionId: null,
    activeSessionId: null,
    loading: false,
  },
)

const emit = defineEmits<{ 'open-detail': [] }>()

const agentStore = useAgentStore()

const identity = computed(() =>
  resolveAgentIdentity({
    agentId: props.agentId,
    fallbackName: props.agentName,
    activeAgent: agentStore.activeAgent,
    agents: agentStore.agents,
  }),
)

const tooltip = computed(() =>
  [identity.value.name, identity.value.description].filter(Boolean).join(' · '),
)

/** 无归属 Agent（历史/系统会话）时不展示，避免出现「Agent」这类无意义占位。 */
const visible = computed(() => !!props.agentId && !!props.sessionId && !props.loading)

/** activeSessionId 追上路由 sessionId 后才可信，否则渲染骨架。 */
const ready = computed(
  () => String(props.activeSessionId || '') === String(props.sessionId || ''),
)
</script>

<style scoped>
.session-agent-bar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  height: 40px;
  min-width: 0;
  padding: 0 12px;
  border-bottom: 1px solid var(--aw-divider-soft);
  background: var(--aw-canvas);
}

.bar-main {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.bar-name {
  max-width: 220px;
  overflow: hidden;
  color: var(--aw-ink);
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar-desc {
  min-width: 0;
  overflow: hidden;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-fine);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar-hint {
  flex-shrink: 0;
  color: var(--aw-ink-muted-40);
  font-size: var(--aw-text-micro);
  white-space: nowrap;
}

.bar-detail {
  flex-shrink: 0;
  padding: 4px 6px;
  border: 0;
  border-radius: var(--aw-radius-xs);
  background: none;
  color: var(--aw-primary);
  font-size: var(--aw-text-fine);
  cursor: pointer;
}

.bar-detail:hover {
  background: var(--aw-primary-hover);
}

.detail-short {
  display: none;
}

.bar-skeleton {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.sk-avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--aw-canvas-parchment);
  animation: agent-bar-pulse 1.2s ease-in-out infinite;
}

.sk-line {
  width: 120px;
  height: 12px;
  border-radius: 6px;
  background: var(--aw-canvas-parchment);
  animation: agent-bar-pulse 1.2s ease-in-out infinite;
}

@keyframes agent-bar-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}

@media (max-width: 768px) {
  .session-agent-bar {
    height: 36px;
    padding: 0 10px;
  }

  .bar-name {
    max-width: 45vw;
    font-size: var(--aw-text-fine);
  }

  .bar-desc,
  .detail-long {
    display: none;
  }

  .detail-short {
    display: inline;
  }
}
</style>
