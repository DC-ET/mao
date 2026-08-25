<template>
  <div class="feishu-bot-page">
    <div class="page-header">
      <h1 class="page-title">飞书机器人绑定</h1>
      <p class="page-desc">
        完成飞书账号授权后，即可在飞书内与机器人对话。绑定以飞书 union_id 为身份锚，绑定一次对所有机器人通用。
      </p>
    </div>

    <div class="binding-card" :class="{ 'is-bound': authorized }">
      <div class="binding-header">
        <div>
          <div class="binding-title">{{ authorized ? '已绑定飞书账号' : '尚未绑定飞书账号' }}</div>
          <div class="binding-desc">
            <template v-if="authorized">
              已绑定飞书身份：{{ unionId || '—' }}<span v-if="boundAt">，绑定时间：{{ boundAt }}</span>
            </template>
            <template v-else>点击下方按钮完成飞书账号授权绑定。</template>
          </div>
        </div>
        <span v-if="authorized" class="status-badge">已绑定</span>
      </div>
      <div class="binding-actions">
        <button class="bind-btn" :disabled="loading" @click="startAuthorization">
          <el-icon v-if="!loading"><Connection /></el-icon>
          {{ loading ? '正在准备授权…' : authorized ? '重新绑定' : '绑定飞书账号' }}
        </button>
        <button v-if="authorized" class="unbind-btn" :disabled="loading" @click="handleUnbind">解绑</button>
      </div>
    </div>

    <el-dialog v-model="dialogVisible" title="绑定飞书账号" width="460px" append-to-body>
      <div class="dialog-content">
        <el-icon class="dialog-icon" :size="42"><Connection /></el-icon>
        <p class="dialog-title">请在打开的飞书页面中完成授权</p>
        <p class="dialog-desc">授权完成后本页会自动检测绑定结果，请稍候。</p>
        <button class="open-link-btn" :disabled="!authUrl" @click="openAuthPage">
          重新打开授权页面
        </button>
        <p v-if="statusText" class="status-text">{{ statusText }}</p>
        <p v-if="dialogError" class="dialog-error">{{ dialogError }}</p>
      </div>
      <template #footer>
        <button class="dialog-btn dialog-btn-cancel" @click="closeDialog">取消</button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { Connection } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'

interface FeishuBindingLink {
  authUrl: string
  qrCodeUrl?: string
  state?: string
}

interface FeishuBindingStatus {
  bound: boolean
  unionId?: string | null
  boundAt?: string | null
}

const loading = ref(false)
const authorized = ref(false)
const unionId = ref('')
const boundAt = ref('')
const dialogVisible = ref(false)
const dialogError = ref('')
const statusText = ref('')
const authUrl = ref('')
let pollTimer: number | null = null
let pollStartedAt = 0

async function loadStatus() {
  try {
    const { data } = await api.get<FeishuBindingStatus>('/feishu/binding/status')
    authorized.value = data?.bound === true
    unionId.value = data?.unionId ?? ''
    boundAt.value = data?.boundAt ?? ''
  } catch {
    // 未登录等场景由 API 拦截器统一提示，这里静默。
  }
}

async function startAuthorization() {
  loading.value = true
  dialogError.value = ''
  statusText.value = ''
  try {
    const { data } = await api.post<FeishuBindingLink>('/feishu/binding')
    authUrl.value = data?.authUrl || data?.qrCodeUrl || ''
    if (!authUrl.value) {
      ElMessage.error('飞书登录未启用，请先在后端配置飞书应用。')
      return
    }
    dialogVisible.value = true
    await openAuthPage()
    startPolling()
  } catch (error: unknown) {
    ElMessage.error(error instanceof Error ? error.message : '获取飞书授权链接失败')
  } finally {
    loading.value = false
  }
}

async function openAuthPage() {
  if (!authUrl.value) return
  if (window.electronAPI?.openFeishuAuthWindow) {
    await window.electronAPI.openFeishuAuthWindow(authUrl.value)
  } else {
    window.open(authUrl.value, '_blank', 'noopener,noreferrer')
  }
}

function startPolling() {
  clearPollTimer()
  pollStartedAt = Date.now()
  pollTimer = window.setInterval(async () => {
    // 授权二维码 5 分钟过期，超时后停止轮询。
    if (Date.now() - pollStartedAt > 5 * 60 * 1000) {
      clearPollTimer()
      statusText.value = '授权超时，请重新发起绑定。'
      return
    }
    try {
      const { data } = await api.get<FeishuBindingStatus>('/feishu/binding/status')
      if (data?.bound === true) {
        clearPollTimer()
        authorized.value = true
        unionId.value = data.unionId ?? ''
        boundAt.value = data.boundAt ?? ''
        statusText.value = '绑定成功'
        dialogVisible.value = false
        ElMessage.success('飞书账号绑定成功')
      } else {
        statusText.value = '仍在等待飞书授权完成，请稍候…'
      }
    } catch {
      // 轮询失败不中断，等待下一次。
    }
  }, 2000)
}

async function handleUnbind() {
  try {
    await ElMessageBox.confirm('解绑后飞书机器人将无法识别您的身份（原工作区与会话保留），确定解绑吗？', '确认解绑', { type: 'warning' })
    loading.value = true
    await api.delete('/feishu/binding')
    authorized.value = false
    unionId.value = ''
    boundAt.value = ''
    ElMessage.success('已解绑')
  } catch {
    // 用户取消或接口失败由拦截器提示。
  } finally {
    loading.value = false
  }
}

function closeDialog() {
  dialogVisible.value = false
  clearPollTimer()
}

function clearPollTimer() {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

onMounted(loadStatus)
onUnmounted(clearPollTimer)
</script>

<style scoped>
.feishu-bot-page { max-width: 640px; }
.page-header { margin-bottom: 24px; }
.page-title { font-size: 20px; font-weight: 600; color: var(--aw-ink); margin: 0 0 8px; }
.page-desc, .binding-desc { font-size: 13px; color: var(--aw-ink-muted); line-height: 1.5; margin: 0; }
.binding-card { background: var(--aw-surface); border: 1px solid var(--aw-divider-soft); border-radius: 8px; padding: 18px; }
.binding-card.is-bound { border-color: var(--aw-primary); }
.binding-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.binding-title { color: var(--aw-ink); font-size: 16px; font-weight: 600; margin-bottom: 5px; }
.status-badge { color: var(--aw-primary); font-size: 12px; }
.binding-actions { display: flex; gap: 10px; }
.bind-btn, .dialog-btn, .open-link-btn, .unbind-btn { border-radius: var(--aw-radius-xs); font-size: 13px; font-weight: 500; cursor: pointer; }
.bind-btn { display: inline-flex; align-items: center; gap: 5px; border: 0; padding: 10px 18px; background: var(--aw-primary); color: #fff; }
.unbind-btn { border: 1px solid var(--aw-danger); padding: 10px 18px; background: transparent; color: var(--aw-danger); }
.bind-btn:disabled, .dialog-btn:disabled, .open-link-btn:disabled, .unbind-btn:disabled { opacity: .55; cursor: not-allowed; }
.dialog-content { padding: 14px 20px 8px; text-align: center; }
.dialog-icon { color: var(--aw-primary); margin-bottom: 10px; }
.dialog-title { color: var(--aw-ink); font-size: 15px; font-weight: 600; margin: 0 0 8px; }
.dialog-desc { color: var(--aw-ink-muted); font-size: 13px; line-height: 1.5; margin: 0 0 18px; }
.open-link-btn { border: 1px solid var(--aw-primary); padding: 7px 14px; background: transparent; color: var(--aw-primary); }
.status-text, .dialog-error { font-size: 12px; line-height: 1.5; margin: 14px 0 0; }
.status-text { color: var(--aw-ink-muted); }
.dialog-error { color: var(--aw-danger); }
.dialog-btn { border: 1px solid var(--aw-hairline); padding: 7px 14px; background: transparent; color: var(--aw-ink-muted); }
.dialog-btn-confirm { border-color: var(--aw-primary); background: var(--aw-primary); color: #fff; margin-left: 8px; }
</style>
