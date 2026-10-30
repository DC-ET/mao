<template>
  <div v-if="visible" class="readiness-banner" :class="{ 'has-red': hasRed }">
    <div class="banner-body">
      <el-icon class="banner-icon"><WarningFilled /></el-icon>
      <span class="banner-title">实例尚未就绪，完成后即可正常使用：</span>
      <template v-if="readiness">
        <button
          v-if="readiness.defaultPasswordChanged === false"
          type="button"
          class="banner-item item-red"
          @click="emit('change-password')"
        >
          <el-icon><Key /></el-icon>
          修改默认管理员密码（admin/admin123，存在安全风险）
        </button>
        <button
          v-if="readiness.modelsConfigured === 0"
          type="button"
          class="banner-item item-yellow"
          @click="go('/models')"
        >
          <el-icon><Cpu /></el-icon>
          配置模型（不配模型无法对话）
        </button>
        <button
          v-if="readiness.agentsEnabled === 0"
          type="button"
          class="banner-item item-yellow"
          @click="go('/agents')"
        >
          <el-icon><Avatar /></el-icon>
          创建第一个 Agent
        </button>
      </template>
      <span v-else class="banner-item item-muted">检查中…</span>
    </div>
    <button type="button" class="banner-dismiss" title="今日不再显示" @click="dismiss">
      <el-icon><Close /></el-icon>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Avatar, Close, Cpu, Key, WarningFilled } from '@element-plus/icons-vue'
import { api } from '../api'
import { useAuthStore } from '../stores/auth'
import type { ReadinessVO } from '@mao/contracts'

const DISMISS_KEY = 'readiness-banner-dismissed-at'

const props = defineProps<{
  /** 外部触发重查（如改密弹窗保存后）。 */
  refreshKey?: number
}>()

const emit = defineEmits<{ 'change-password': [] }>()

const router = useRouter()
const authStore = useAuthStore()
const readiness = ref<ReadinessVO | null>(null)
const dismissedToday = ref(false)

const hasRed = computed(() => readiness.value?.defaultPasswordChanged === false)
const visible = computed(() => {
  if (!authStore.isAdmin || readiness.value == null || dismissedToday.value) return false
  return hasRed.value || readiness.value.modelsConfigured === 0 || readiness.value.agentsEnabled === 0
})

async function fetchReadiness() {
  try {
    const { data } = await api.get<unknown, { data: ReadinessVO }>('/readiness')
    readiness.value = data
  } catch {
    readiness.value = null
  }
}

function go(path: string) {
  router.push(path)
}

function dismiss() {
  dismissedToday.value = true
  localStorage.setItem(DISMISS_KEY, new Date().toDateString())
}

function restoreDismissed() {
  dismissedToday.value = localStorage.getItem(DISMISS_KEY) === new Date().toDateString()
}

watch(() => props.refreshKey, () => {
  restoreDismissed()
  void fetchReadiness()
})

watch(() => authStore.isAdmin, (admin) => {
  if (admin) void fetchReadiness()
  else readiness.value = null
})

onMounted(() => {
  restoreDismissed()
  if (authStore.isAdmin) void fetchReadiness()
})
</script>

<style scoped>
.readiness-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: var(--el-color-warning-light-9);
  font-size: 13px;
}

.readiness-banner.has-red {
  background: var(--el-color-danger-light-9);
}

.banner-body {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 14px;
  min-width: 0;
}

.banner-icon {
  color: var(--el-color-warning);
  flex-shrink: 0;
}

.has-red .banner-icon {
  color: var(--el-color-danger);
}

.banner-title {
  color: var(--el-text-color-primary);
  font-weight: 500;
}

.banner-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: none;
  background: transparent;
  font-size: 13px;
  cursor: pointer;
}

.item-red {
  color: var(--el-color-danger);
  font-weight: 600;
}

.item-yellow {
  color: var(--el-color-warning-dark-2);
}

.item-muted {
  color: var(--el-text-color-secondary);
  cursor: default;
}

.banner-item:not(.item-muted):hover {
  text-decoration: underline;
}

.banner-dismiss {
  display: inline-flex;
  align-items: center;
  padding: 4px;
  border: none;
  background: transparent;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  flex-shrink: 0;
}

.banner-dismiss:hover {
  color: var(--el-text-color-primary);
}
</style>
