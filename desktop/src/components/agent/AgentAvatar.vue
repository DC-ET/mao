<template>
  <img
    v-if="resolvedUrl"
    :src="resolvedUrl"
    :alt="name"
    class="agent-avatar"
    :style="boxStyle"
  />
  <span v-else class="agent-avatar agent-avatar-fallback" :style="boxStyle">{{ initial }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { resolveAvatarUrl } from '../../utils/avatar'

const props = withDefaults(
  defineProps<{
    name?: string
    avatarUrl?: string | null
    size?: number
  }>(),
  {
    name: '',
    avatarUrl: null,
    size: 22,
  },
)

const resolvedUrl = computed(() => resolveAvatarUrl(props.avatarUrl))

/** 中文取首字；英文等在展示时统一大写，避免同一 Agent 在不同位置大小写不一致。 */
const initial = computed(() => {
  const trimmed = props.name.trim()
  const first = Array.from(trimmed)[0]
  return first ? first.toUpperCase() : '?'
})

const boxStyle = computed(() => ({
  '--agent-avatar-size': `${props.size}px`,
}))
</script>

<style scoped>
.agent-avatar {
  flex-shrink: 0;
  width: var(--agent-avatar-size, 22px);
  height: var(--agent-avatar-size, 22px);
  border-radius: 50%;
  object-fit: cover;
  background: var(--aw-primary);
}

.agent-avatar-fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--aw-on-primary);
  font-size: calc(var(--agent-avatar-size, 22px) * 0.44);
  font-weight: 600;
  line-height: 1;
}
</style>
