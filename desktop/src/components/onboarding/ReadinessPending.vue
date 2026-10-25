<template>
  <div class="readiness-pending" role="dialog" aria-label="等待实例配置">
    <div class="pending-card">
      <el-icon :size="40" class="pending-icon"><Loading /></el-icon>
      <h2 class="pending-title">{{ reason === 'models' ? '实例尚未配置模型' : '暂无可用智能体' }}</h2>
      <p class="pending-desc">
        {{ reason === 'models'
          ? '管理员还没有配置可用的模型 API Key，配置完成后就能开始对话了。请联系管理员，或稍后点击下方按钮重试。'
          : '管理员还没有创建或启用智能体，创建完成后就能开始对话了。请联系管理员，或稍后点击下方按钮重试。' }}
      </p>
      <el-button type="primary" :loading="refreshing" @click="refresh">重试</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { Loading } from '@element-plus/icons-vue'

defineProps<{
  reason: 'models' | 'agents'
}>()

const emit = defineEmits<{ retry: [] }>()

const refreshing = ref(false)

function refresh() {
  refreshing.value = true
  emit('retry')
  // emit 同步处理后由父组件翻转覆盖层；按钮 loading 短暂自愈
  setTimeout(() => { refreshing.value = false }, 600)
}
</script>

<style scoped>
.readiness-pending {
  position: absolute;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--aw-canvas-parchment);
  padding: 16px;
}

.pending-card {
  width: min(420px, 100%);
  background: var(--aw-surface);
  border-radius: 12px;
  padding: 32px 28px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.pending-icon {
  color: var(--aw-primary);
}

.pending-title {
  margin: 0;
  font-size: 17px;
  color: var(--aw-ink);
}

.pending-desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--aw-ink-muted);
}
</style>
