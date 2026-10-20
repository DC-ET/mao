<template>
  <span
    class="agent-badge"
    :class="[`size-${size}`, { 'is-unresolved': !identity.resolved, 'is-avatar-only': avatarOnly }]"
    :role="avatarOnly ? 'img' : undefined"
    :aria-label="avatarOnly ? identity.name : undefined"
    :title="avatarOnly ? identity.name : undefined"
  >
    <AgentAvatar :name="identity.name" :avatar-url="identity.avatarUrl" :size="avatarSize" />
    <span v-if="!avatarOnly" class="agent-badge-text">
      <span class="agent-badge-name" :title="tooltip">{{ identity.name }}</span>
      <span v-if="showDescription && identity.description" class="agent-badge-desc">{{ identity.description }}</span>
    </span>
    <span v-if="!avatarOnly && !identity.resolved" class="agent-badge-hint">已停用或不可见</span>
  </span>
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
    size?: 'sm' | 'md' | 'lg'
    showDescription?: boolean
    avatarOnly?: boolean
  }>(),
  {
    agentId: null,
    agentName: null,
    size: 'md',
    showDescription: false,
    avatarOnly: false,
  },
)

const agentStore = useAgentStore()

const identity = computed(() =>
  resolveAgentIdentity({
    agentId: props.agentId,
    fallbackName: props.agentName,
    activeAgent: agentStore.activeAgent,
    agents: agentStore.agents,
  }),
)

const avatarSize = computed(() => ({ sm: 18, md: 22, lg: 36 }[props.size]))

const tooltip = computed(() =>
  [identity.value.name, identity.value.description].filter(Boolean).join(' · '),
)
</script>

<style scoped>
.agent-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--aw-ink);
  font-size: var(--aw-text-fine);
}

.agent-badge.size-md {
  gap: 8px;
}

.agent-badge.size-lg {
  gap: 10px;
}

.agent-badge-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.agent-badge-name {
  overflow: hidden;
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-badge.size-sm .agent-badge-name {
  font-size: var(--aw-text-fine);
  font-weight: 500;
  line-height: 16px;
}

.agent-badge-desc {
  overflow: hidden;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-fine);
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-badge-hint {
  flex-shrink: 0;
  color: var(--aw-ink-muted-40);
  font-size: var(--aw-text-micro);
  white-space: nowrap;
}

.agent-badge.is-avatar-only {
  gap: 0;
}
</style>
