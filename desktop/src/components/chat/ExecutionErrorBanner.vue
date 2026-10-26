<template>
  <div v-if="message" class="execution-error-banner" role="alert">
    <div class="error-header">
      <el-icon class="error-icon" :size="14"><WarningFilled /></el-icon>
      <span class="error-title">执行异常</span>
    </div>
    <pre class="error-message">{{ message }}</pre>
    <el-button
      v-if="canRetry"
      class="retry-button"
      type="primary"
      size="small"
      @click="emit('retry')"
    >
      重试
    </el-button>
    <!-- 排障锚点：用户看到报错时最直觉的反馈入口，一键复制会话 ID 给管理员 -->
    <el-button
      v-if="sessionId"
      class="copy-id-button"
      size="small"
      @click="copySessionId"
    >
      复制会话 ID
    </el-button>
    <!-- 可选行动按钮（P3 预算被拦：「查看我的预算」跳用量抽屉预算 Tab） -->
    <el-button
      v-if="actionLabel"
      class="action-button"
      size="small"
      @click="emit('action')"
    >
      {{ actionLabel }}
    </el-button>
  </div>
</template>

<script setup lang="ts">
import { WarningFilled } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { copyText } from '../../utils/clipboard'

const props = defineProps<{
  message: string | null
  canRetry?: boolean
  /** 出错会话的 ID：有值才显示「复制会话 ID」按钮（新建未落库等无会话场景不显示） */
  sessionId?: string
  /** 可选行动按钮文案（如预算被拦时的「查看我的预算」）；不传不渲染 */
  actionLabel?: string
}>()

const emit = defineEmits<{
  retry: []
  action: []
}>()

async function copySessionId() {
  const sid = props.sessionId
  if (!sid) return
  const ok = await copyText(sid)
  if (ok) {
    ElMessage.success('会话 ID 已复制')
  } else {
    ElMessage.error('复制失败，请手动记录会话 ID')
  }
}
</script>

<style scoped>
.execution-error-banner {
  margin-bottom: 8px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--aw-danger) 35%, var(--aw-hairline));
  border-radius: var(--aw-radius-sm);
  background: color-mix(in srgb, var(--aw-danger) 6%, var(--aw-canvas));
}

.error-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.error-icon {
  color: var(--aw-danger);
  flex-shrink: 0;
}

.error-title {
  font-size: var(--aw-text-fine);
  font-weight: 600;
  color: var(--aw-danger);
}

.error-message {
  margin: 0;
  padding: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  font-size: var(--aw-text-caption);
  line-height: 1.45;
  color: var(--aw-ink-muted-80);
  max-height: 120px;
  overflow-y: auto;
}

.retry-button {
  margin-top: 10px;
}

/* 单独出现时自身撑开上边距；与重试并排时交给 el-button 相邻规则，避免叠加缩进 */
.copy-id-button {
  margin-top: 10px;
  margin-left: 8px;
}

.action-button {
  margin-top: 10px;
  margin-left: 8px;
}
</style>
