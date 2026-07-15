<template>
  <div class="weixin-bot-page">
    <div class="page-header">
      <h1 class="page-title">微信Bot绑定</h1>
      <p class="page-desc">
        绑定微信Bot后，您可以通过微信与AI Agent进行对话，无需打开桌面客户端。
      </p>
    </div>

    <div v-if="loading" class="empty-state">加载中...</div>
    <div v-else-if="bindingStatus.bound" class="binding-info">
      <div class="binding-card">
        <div class="binding-header">
          <div class="binding-title">已绑定微信Bot</div>
          <div class="binding-actions">
            <button class="action-btn action-btn-danger" @click="handleUnbind">
              解绑
            </button>
          </div>
        </div>
        <div class="binding-meta">
          <span class="binding-time">绑定时间：{{ formatTime(bindingStatus.boundAt) }}</span>
          <span class="binding-account">账号：{{ bindingStatus.accountId }}</span>
        </div>
      </div>
    </div>
    <div v-else class="binding-action">
      <button class="bind-btn" @click="handleBind">
        <el-icon><Plus /></el-icon>
        绑定微信Bot
      </button>

      <el-dialog
        v-model="dialogVisible"
        title="绑定微信Bot"
        width="480px"
        class="weixin-bot-dialog"
        append-to-body
        @closed="resetQrcode"
      >
        <div class="qrcode-container">
          <div v-if="qrcodeLoading" class="qrcode-loading">加载中...</div>
          <div v-else-if="qrcodeError" class="qrcode-error">
            <p>{{ qrcodeError }}</p>
            <button class="retry-btn" @click="fetchQrcode">重试</button>
          </div>
          <div v-else class="qrcode-content">
            <img :src="qrcodeData.qrDataUrl" alt="微信扫码二维码" class="qrcode-image" />
            <p class="qrcode-tip">{{ qrcodeData.message }}</p>
            <div v-if="scanStatus" class="scan-status">
              <p v-if="scanStatus === 'wait'">等待扫码...</p>
              <p v-else-if="scanStatus === 'scaned'">已扫码，请确认登录</p>
              <p v-else-if="scanStatus === 'confirmed'">绑定成功！</p>
              <p v-else-if="scanStatus === 'expired'">二维码已过期，请重新获取</p>
            </div>
          </div>
        </div>
        <template #footer>
          <button class="dialog-btn dialog-btn-cancel" @click="dialogVisible = false">取消</button>
          <button
            v-if="scanStatus === 'expired'"
            class="dialog-btn dialog-btn-confirm"
            @click="fetchQrcode"
          >
            重新获取
          </button>
        </template>
      </el-dialog>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import QRCode from 'qrcode'
import { api } from '../../api'

interface BindingStatus {
  bound: boolean
  accountId?: string
  boundAt?: string
}

interface QrcodeData {
  sessionKey: string
  qrDataUrl: string
  message: string
}

interface QrcodeStatusData {
  status: string
  botToken?: string
  baseUrl?: string
  ilinkUserId?: string
}

const loading = ref(false)
const bindingStatus = ref<BindingStatus>({ bound: false })
const dialogVisible = ref(false)
const qrcodeLoading = ref(false)
const qrcodeError = ref('')
const qrcodeData = ref<QrcodeData>({ sessionKey: '', qrDataUrl: '', message: '' })
const scanStatus = ref('')
let statusPollingTimer: number | null = null
let pollingActive = false

function formatTime(value?: string) {
  if (!value) return '-'
  return value.replace('T', ' ').slice(0, 16)
}

async function fetchBindingStatus() {
  loading.value = true
  try {
    const { data } = await api.get('/weixin/binding/status')
    bindingStatus.value = data || { bound: false }
  } finally {
    loading.value = false
  }
}

async function fetchQrcode() {
  qrcodeLoading.value = true
  qrcodeError.value = ''
  scanStatus.value = ''
  try {
    const { data } = await api.get('/weixin/qrcode')
    // qrcode_img_content 是微信页面URL，不是图片，需要用 qrcode 库生成二维码图片
    const qrImageUrl = data.qrDataUrl
    const dataUrl = await QRCode.toDataURL(qrImageUrl, {
      width: 256,
      margin: 2,
      errorCorrectionLevel: 'M'
    })
    qrcodeData.value = { ...data, qrDataUrl: dataUrl }
    startStatusPolling()
  } catch (error: any) {
    qrcodeError.value = error.message || '获取二维码失败'
  } finally {
    qrcodeLoading.value = false
  }
}

function startStatusPolling() {
  stopStatusPolling()
  pollingActive = true
  pollStatus()
}

async function pollStatus() {
  if (!pollingActive) return

  try {
    const { data } = await api.get<QrcodeStatusData>('/weixin/qrcode/status', {
      params: { sessionKey: qrcodeData.value.sessionKey },
      timeout: 12000,
      skipErrorToast: true
    } as any)
    scanStatus.value = data.status

    if (data.status === 'confirmed') {
      stopStatusPolling()

      // 确认绑定
      if (data.botToken && data.baseUrl && data.ilinkUserId) {
        await api.post('/weixin/binding/confirm', null, {
          params: {
            sessionKey: qrcodeData.value.sessionKey,
            botToken: data.botToken,
            baseUrl: data.baseUrl,
            ilinkUserId: data.ilinkUserId
          }
        })
      }

      ElMessage.success('微信Bot绑定成功！')
      dialogVisible.value = false
      await fetchBindingStatus()
    } else if (data.status === 'expired') {
      stopStatusPolling()
    } else {
      // 继续轮询（等上一轮完成后再发起下一轮，避免请求堆积）
      if (pollingActive) {
        statusPollingTimer = window.setTimeout(pollStatus, 2000)
      }
    }
  } catch (error) {
    console.error('查询扫码状态失败:', error)
    // 超时或网络错误时继续轮询，不中断等待流程
    if (pollingActive) {
      statusPollingTimer = window.setTimeout(pollStatus, 3000)
    }
  }
}

function stopStatusPolling() {
  pollingActive = false
  if (statusPollingTimer) {
    clearTimeout(statusPollingTimer)
    statusPollingTimer = null
  }
}

function resetQrcode() {
  stopStatusPolling()
  qrcodeData.value = { sessionKey: '', qrDataUrl: '', message: '' }
  scanStatus.value = ''
  qrcodeError.value = ''
}

function handleBind() {
  dialogVisible.value = true
  fetchQrcode()
}

async function handleUnbind() {
  try {
    await ElMessageBox.confirm(
      '确定要解绑微信Bot吗？解绑后将无法通过微信与AI Agent对话。',
      '确认解绑',
      { confirmButtonText: '确定解绑', cancelButtonText: '取消', type: 'warning' }
    )

    await api.delete('/weixin/binding')
    ElMessage.success('已成功解绑微信Bot')
    await fetchBindingStatus()
  } catch (error: any) {
    if (error !== 'cancel') {
      ElMessage.error(error.message || '解绑失败')
    }
  }
}

onMounted(() => {
  fetchBindingStatus()
})

onUnmounted(() => {
  stopStatusPolling()
})
</script>

<style scoped>
.weixin-bot-page {
  max-width: 640px;
}

.page-header {
  margin-bottom: 24px;
}

.page-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--aw-ink);
  margin: 0 0 8px;
}

.page-desc {
  font-size: 13px;
  color: var(--aw-ink-muted);
  margin: 0;
  line-height: 1.5;
}

.empty-state {
  text-align: center;
  padding: 48px 16px;
  color: var(--aw-ink-muted);
  font-size: 13px;
}

.binding-card {
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider-soft);
  border-radius: 8px;
  padding: 16px;
}

.binding-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.binding-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--aw-ink);
}

.binding-actions {
  display: flex;
  gap: 8px;
}

.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border: none;
  border-radius: var(--aw-radius-xs);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s;
}

.action-btn:hover {
  opacity: 0.85;
}

.action-btn-danger {
  background: var(--aw-danger);
  color: #fff;
}

.binding-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: var(--aw-ink-muted);
}

.bind-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 10px 20px;
  border: none;
  border-radius: var(--aw-radius-xs);
  background: var(--aw-primary);
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s;
}

.bind-btn:hover {
  opacity: 0.85;
}

.qrcode-container {
  text-align: center;
  padding: 20px;
}

.qrcode-loading {
  padding: 40px;
  color: var(--aw-ink-muted);
}

.qrcode-error {
  padding: 20px;
  color: var(--aw-danger);
}

.retry-btn {
  margin-top: 12px;
  padding: 6px 16px;
  border: 1px solid var(--aw-primary);
  border-radius: var(--aw-radius-xs);
  background: transparent;
  color: var(--aw-primary);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}

.retry-btn:hover {
  background: rgba(0, 102, 204, 0.08);
}

.qrcode-image {
  max-width: 256px;
  max-height: 256px;
  margin-bottom: 16px;
}

.qrcode-tip {
  font-size: 13px;
  color: var(--aw-ink-muted);
  margin: 0 0 12px;
}

.scan-status {
  font-size: 14px;
  color: var(--aw-ink);
  font-weight: 500;
}

.scan-status p {
  margin: 0;
}

.dialog-btn {
  padding: 6px 16px;
  border: none;
  border-radius: var(--aw-radius-xs);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

.dialog-btn-cancel {
  background: transparent;
  color: var(--aw-ink-muted);
  border: 1px solid var(--aw-hairline);
}

.dialog-btn-confirm {
  background: var(--aw-primary);
  color: #fff;
  margin-left: 8px;
}

.dialog-btn-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>

<style>
.weixin-bot-dialog {
  --el-font-size-base: 13px;
  --el-font-size-small: 12px;
  --el-font-size-extra-small: 11px;
}

.weixin-bot-dialog .el-dialog__title {
  font-size: 15px;
  font-weight: 600;
}

.weixin-bot-dialog .el-dialog__body {
  padding-top: 12px;
}
</style>