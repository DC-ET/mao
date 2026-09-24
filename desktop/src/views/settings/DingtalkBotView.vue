<template>
  <div class="dingtalk-bot-page">
    <div class="page-header">
      <h1 class="page-title">钉钉机器人绑定</h1>
      <p class="page-desc">
        完成钉钉账号授权后，即可在钉钉里私聊机器人，或在群里 @ 机器人。绑定把当前 Mao 用户和钉钉 userid 连起来，绑定一次对所有机器人通用。钉钉身份不会创建新的 Mao 账号。
      </p>
    </div>

    <div class="binding-card" :class="{ 'is-bound': authorized }">
      <div class="binding-header">
        <div>
          <div class="binding-title">{{ authorized ? '已绑定钉钉账号' : '尚未绑定钉钉账号' }}</div>
          <div class="binding-desc">
            <template v-if="authorized">已绑定钉钉 userid：{{ userid || '—' }}<span v-if="boundAt">，绑定时间：{{ boundAt }}</span></template>
            <template v-else>点击下方按钮，在钉钉授权页确认后完成绑定。</template>
          </div>
        </div>
        <span v-if="authorized" class="status-badge">已绑定</span>
      </div>
      <div class="binding-actions">
        <button class="bind-btn" :disabled="loading" @click="startAuthorization">
          {{ loading ? '正在准备授权…' : authorized ? '重新绑定' : '绑定钉钉账号' }}
        </button>
        <button v-if="authorized" class="unbind-btn" :disabled="loading" @click="handleUnbind">解绑</button>
      </div>
    </div>

    <el-dialog v-model="dialogVisible" title="绑定钉钉账号" width="460px" append-to-body @closed="clearPollTimer">
      <div class="dialog-content">
        <p class="dialog-title">请在打开的钉钉页面中完成授权</p>
        <p class="dialog-desc">授权完成后本页会自动检测绑定结果。</p>
        <button class="open-link-btn" :disabled="!authUrl" @click="openAuthPage">重新打开授权页面</button>
        <p v-if="statusText" class="status-text">{{ statusText }}</p>
      </div>
      <template #footer>
        <button class="dialog-btn" @click="dialogVisible = false">取消</button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'

interface BindingStatus { bound: boolean; userid?: string | null; boundAt?: string | null }

const route = useRoute()
const loading = ref(false)
const authorized = ref(false)
const userid = ref('')
const boundAt = ref('')
const dialogVisible = ref(false)
const statusText = ref('')
const authUrl = ref('')
let pollTimer: number | null = null
let pollStartedAt = 0

async function loadStatus() {
  try {
    const { data } = await api.get<BindingStatus>('/dingtalk/binding/status')
    authorized.value = data?.bound === true
    userid.value = data?.userid ?? ''
    boundAt.value = data?.boundAt ?? ''
  } catch { /* 拦截器提示 */ }
}

async function startAuthorization() {
  loading.value = true
  statusText.value = ''
  try {
    const { data } = await api.post<{ authUrl: string }>('/dingtalk/binding')
    authUrl.value = data?.authUrl || ''
    if (!authUrl.value) {
      ElMessage.error('管理员尚未配置钉钉登录，暂时无法绑定')
      return
    }
    dialogVisible.value = true
    window.open(authUrl.value, '_blank', 'noopener,noreferrer')
    startPolling()
  } catch (error: unknown) {
    ElMessage.error(error instanceof Error ? error.message : '获取钉钉授权链接失败')
  } finally {
    loading.value = false
  }
}

function openAuthPage() {
  if (authUrl.value) window.open(authUrl.value, '_blank', 'noopener,noreferrer')
}

function startPolling() {
  clearPollTimer()
  pollStartedAt = Date.now()
  const baselineUserid = userid.value
  const baselineBoundAt = boundAt.value
  pollTimer = window.setInterval(async () => {
    if (Date.now() - pollStartedAt > 10 * 60 * 1000) {
      clearPollTimer()
      statusText.value = '授权超时，请重新发起绑定。'
      return
    }
    try {
      const { data } = await api.get<BindingStatus>('/dingtalk/binding/status')
      const nextUserid = data?.userid ?? ''
      const nextBoundAt = data?.boundAt ?? ''
      if (data?.bound === true && (nextUserid !== baselineUserid || nextBoundAt !== baselineBoundAt)) {
        clearPollTimer()
        authorized.value = true
        userid.value = nextUserid
        boundAt.value = nextBoundAt
        dialogVisible.value = false
        ElMessage.success('钉钉账号绑定成功')
      } else {
        statusText.value = '仍在等待钉钉授权完成…'
      }
    } catch { /* 下一轮再试 */ }
  }, 2000)
}

async function handleUnbind() {
  try {
    await ElMessageBox.confirm('解绑后钉钉机器人将无法识别您的身份（原工作区与会话保留），确定解绑吗？', '确认解绑', { type: 'warning' })
    loading.value = true
    await api.delete('/dingtalk/binding')
    authorized.value = false
    userid.value = ''
    boundAt.value = ''
    ElMessage.success('已解绑')
  } catch { /* 取消或拦截器 */ } finally {
    loading.value = false
  }
}

function clearPollTimer() {
  if (pollTimer != null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

onMounted(async () => {
  await loadStatus()
  const bound = route.query.bound
  const bindError = route.query.bindError
  if (bound === '1') ElMessage.success('钉钉账号绑定成功')
  if (typeof bindError === 'string' && bindError !== '') ElMessage.error(bindError === 'expired' ? '绑定链接已失效，请重新发起' : bindError)
})
onUnmounted(clearPollTimer)
</script>

<style scoped>
.dingtalk-bot-page { max-width: 640px; }
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
.bind-btn { border: 0; padding: 6px 12px; background: var(--aw-primary); color: #fff; }
.unbind-btn { border: 1px solid var(--aw-danger); padding: 6px 12px; background: transparent; color: var(--aw-danger); }
.bind-btn:disabled, .unbind-btn:disabled, .open-link-btn:disabled { opacity: .55; cursor: not-allowed; }
.dialog-content { padding: 8px 4px; text-align: center; }
.dialog-title { color: var(--aw-ink); font-size: 15px; font-weight: 600; margin: 0 0 8px; }
.dialog-desc, .status-text { color: var(--aw-ink-muted); font-size: 13px; }
.open-link-btn { border: 1px solid var(--aw-primary); padding: 7px 14px; background: transparent; color: var(--aw-primary); }
.dialog-btn { border: 1px solid var(--aw-hairline); padding: 7px 14px; background: transparent; color: var(--aw-ink-muted); }
</style>
