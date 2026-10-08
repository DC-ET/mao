<template>
  <div class="notification-settings-page">
    <header class="page-header">
      <div>
        <h1 class="page-title">消息通知</h1>
        <p class="page-desc">Agent 后台任务完成或失败后发送通知。</p>
      </div>
      <el-switch
        v-model="form.enabled"
        :disabled="loading || saving"
        inline-prompt
        active-text="开"
        inactive-text="关"
        aria-label="任务完成通知"
      />
    </header>

    <div v-if="loading" class="loading-state">加载中...</div>

    <template v-else>
      <section v-if="form.enabled" class="settings-section">
        <label class="field-label">推送方式</label>
        <el-segmented
          v-model="form.channel"
          :options="channelOptions"
          class="channel-control"
          @change="handleChannelChange"
        />
      </section>

      <section v-if="form.enabled && form.channel" class="settings-section webhook-section">
        <label class="field-label" for="notification-webhook">Webhook 地址</label>
        <el-input
          id="notification-webhook"
          v-model="form.webhookUrl"
          :type="showWebhook ? 'text' : 'password'"
          :placeholder="webhookPlaceholder"
          autocomplete="off"
          @input="webhookError = ''"
        >
          <template #suffix>
            <el-tooltip :content="showWebhook ? '隐藏地址' : '显示地址'" :show-after="300">
              <button class="input-icon-btn" type="button" @click="showWebhook = !showWebhook">
                <el-icon><Hide v-if="showWebhook" /><View v-else /></el-icon>
              </button>
            </el-tooltip>
          </template>
        </el-input>
        <p v-if="webhookError" class="field-error">{{ webhookError }}</p>
        <p v-else-if="preference.webhookConfigured && !form.webhookUrl" class="configured-hint">
          <el-icon><CircleCheck /></el-icon>
          已配置 {{ preference.maskedWebhook }}
        </p>
      </section>

      <footer class="page-actions">
        <button
          v-if="form.enabled"
          class="secondary-btn"
          type="button"
          :disabled="!canTest || testing || saving"
          @click="handleTest"
        >
          <el-icon><Connection /></el-icon>
          {{ testing ? '发送中...' : '发送测试通知' }}
        </button>
        <button class="primary-btn" type="button" :disabled="!canSave || saving || testing" @click="handleSave">
          <el-icon><Check /></el-icon>
          {{ saving ? '保存中...' : '保存' }}
        </button>
      </footer>
    </template>

    <section class="settings-section inbox-section">
      <div class="section-head">
        <div>
          <label class="field-label">站内收件箱</label>
          <p class="field-desc">
            顶栏消息图标的未读徽标。关闭后对应事件不再写入收件箱，不影响上面的 IM / Webhook 推送。
          </p>
        </div>
        <el-switch
          v-if="isElectronClient()"
          v-model="inboxForm.systemNotifyEnabled"
          :loading="inboxSaving"
          inline-prompt
          active-text="开"
          inactive-text="关"
          aria-label="Electron 系统通知"
        />
      </div>

      <div class="inbox-kind-row">
        <span class="inbox-kind-label">系统通知</span>
        <span class="inbox-kind-hint">仅桌面客户端在窗口未聚焦时弹出；点击可直达关联任务</span>
      </div>

      <div class="inbox-kind-row">
        <span class="inbox-kind-label">任务完成通知</span>
        <el-switch
          v-model="inboxForm.taskCompletedEnabled"
          :loading="inboxSaving"
          inline-prompt
          active-text="开"
          inactive-text="关"
          aria-label="任务完成收件箱通知"
        />
      </div>
      <div class="inbox-kind-row">
        <span class="inbox-kind-label">提问待答通知</span>
        <el-switch
          v-model="inboxForm.questionPendingEnabled"
          :loading="inboxSaving"
          inline-prompt
          active-text="开"
          inactive-text="关"
          aria-label="提问待答收件箱通知"
        />
      </div>
      <div class="inbox-kind-row">
        <span class="inbox-kind-label">审批待办通知</span>
        <el-switch
          v-model="inboxForm.approvalPendingEnabled"
          :loading="inboxSaving"
          inline-prompt
          active-text="开"
          inactive-text="关"
          aria-label="审批待办收件箱通知"
        />
      </div>
      <div class="inbox-kind-row">
        <span class="inbox-kind-label">子代理完成通知</span>
        <el-switch
          v-model="inboxForm.subagentDoneEnabled"
          :loading="inboxSaving"
          inline-prompt
          active-text="开"
          inactive-text="关"
          aria-label="子代理完成收件箱通知"
        />
      </div>
      <div class="inbox-kind-row">
        <span class="inbox-kind-label">预算提醒通知</span>
        <el-switch
          v-model="inboxForm.budgetWarnEnabled"
          :loading="inboxSaving"
          inline-prompt
          active-text="开"
          inactive-text="关"
          aria-label="预算提醒收件箱通知"
        />
      </div>

      <div class="inbox-actions">
        <button
          class="secondary-btn"
          type="button"
          :disabled="inboxSaving || !inboxDirty"
          @click="handleSaveInboxPreference"
        >
          <el-icon><Check /></el-icon>
          {{ inboxSaving ? '保存中...' : '保存收件箱设置' }}
        </button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { Check, CircleCheck, Connection, Hide, View } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import {
  getTaskNotificationPreference,
  saveTaskNotificationPreference,
  testTaskNotification,
  getInboxPreference as fetchInboxPreferenceApi,
  saveInboxPreference as saveInboxPreferenceApi,
  type NotificationChannel,
  type TaskNotificationPreference,
  type InboxPreference
} from '../../api'
import { isElectronClient } from '../../utils/platform'

const channelOptions = [
  { label: '钉钉', value: 'DINGTALK' },
  { label: '飞书', value: 'FEISHU' }
]

const loading = ref(true)
const saving = ref(false)
const testing = ref(false)
const showWebhook = ref(false)
const webhookError = ref('')
const savedChannel = ref<NotificationChannel | null>(null)
/** 已保存配置的快照：切走渠道后再切回时恢复「已配置」展示状态 */
const savedConfigured = ref(false)
const savedMaskedWebhook = ref<string | null>(null)
const preference = reactive<TaskNotificationPreference>({
  enabled: false,
  channel: null,
  webhookConfigured: false,
  maskedWebhook: null
})
const form = reactive<{
  enabled: boolean
  channel: NotificationChannel | null
  webhookUrl: string
}>({
  enabled: false,
  channel: null,
  webhookUrl: ''
})

const webhookPlaceholder = computed(() => {
  if (preference.webhookConfigured && form.channel === savedChannel.value) return '留空则保留已配置地址'
  return form.channel === 'DINGTALK'
    ? 'https://oapi.dingtalk.com/robot/send?access_token=...'
    : 'https://open.feishu.cn/open-apis/bot/v2/hook/...'
})

const hasUsableWebhook = computed(() => {
  return form.webhookUrl.trim().length > 0
    || (preference.webhookConfigured && form.channel === savedChannel.value)
})

const canTest = computed(() => Boolean(form.channel && hasUsableWebhook.value))
const canSave = computed(() => !form.enabled || Boolean(form.channel && hasUsableWebhook.value))

// ─── 站内收件箱偏好（分区独立保存：不得并入受 canSave 门禁的整页保存） ───
const inboxSaving = ref(false)
const inboxSaved = reactive<InboxPreference>({
  taskCompletedEnabled: true,
  questionPendingEnabled: true,
  approvalPendingEnabled: true,
  subagentDoneEnabled: false,
  budgetWarnEnabled: true,
  systemNotifyEnabled: true
})
const inboxForm = reactive<InboxPreference>({ ...inboxSaved })
const inboxDirty = computed(() => {
  return (Object.keys(inboxForm) as Array<keyof InboxPreference>).some(
    (key) => inboxForm[key] !== inboxSaved[key]
  )
})

async function loadInboxPreference() {
  try {
    const data = await fetchInboxPreferenceApi()
    Object.assign(inboxSaved, data)
    Object.assign(inboxForm, data)
  } catch {
    // 错误 toast 由 API 拦截器统一处理；保留默认值
  }
}

async function handleSaveInboxPreference() {
  if (!inboxDirty.value) return
  inboxSaving.value = true
  try {
    const saved = await saveInboxPreferenceApi({ ...inboxForm })
    Object.assign(inboxSaved, saved)
    Object.assign(inboxForm, saved)
    ElMessage.success('收件箱设置已保存')
  } catch {
    // 错误 toast 由 API 拦截器统一处理
  } finally {
    inboxSaving.value = false
  }
}

// 未保存的改动在离开页面前丢回去，避免下次进来看到脏表单
watch(
  () => inboxSaved,
  () => Object.assign(inboxForm, inboxSaved),
  { deep: true }
)

function validateWebhook(): boolean {
  webhookError.value = ''
  const value = form.webhookUrl.trim()
  if (!value) return hasUsableWebhook.value
  const valid = form.channel === 'DINGTALK'
    ? /^https:\/\/oapi\.dingtalk\.com\/robot\/send\?[^#]*access_token=[^&#]+(?:&[^#]*)?$/.test(value)
    : /^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[^/?#]+$/.test(value)
  if (!valid) webhookError.value = '地址与所选推送方式不匹配'
  return valid
}

function handleChannelChange(value: string | number | boolean) {
  const next = value as NotificationChannel
  form.webhookUrl = ''
  showWebhook.value = false
  webhookError.value = ''
  if (next !== savedChannel.value) {
    preference.webhookConfigured = false
    preference.maskedWebhook = null
  } else {
    // 切回已保存渠道：恢复快照，让「已配置地址」状态与占位提示回归
    preference.webhookConfigured = savedConfigured.value
    preference.maskedWebhook = savedMaskedWebhook.value
  }
}

async function loadPreference() {
  loading.value = true
  try {
    const data = await getTaskNotificationPreference()
    Object.assign(preference, data)
    form.enabled = data.enabled
    form.channel = data.channel
    form.webhookUrl = ''
    savedChannel.value = data.channel
    savedConfigured.value = data.webhookConfigured
    savedMaskedWebhook.value = data.maskedWebhook
  } finally {
    loading.value = false
  }
}

async function handleTest() {
  if (!form.channel || !validateWebhook()) return
  testing.value = true
  try {
    await testTaskNotification({
      channel: form.channel,
      webhookUrl: form.webhookUrl.trim() || undefined
    })
    ElMessage.success('测试通知发送成功')
  } catch {
    // Error toast is handled by the shared API interceptor.
  } finally {
    testing.value = false
  }
}

async function handleSave() {
  if (form.enabled && !validateWebhook()) return
  saving.value = true
  try {
    const data = await saveTaskNotificationPreference({
      enabled: form.enabled,
      channel: form.channel,
      webhookUrl: form.webhookUrl.trim() || undefined
    })
    Object.assign(preference, data)
    savedChannel.value = data.channel
    savedConfigured.value = data.webhookConfigured
    savedMaskedWebhook.value = data.maskedWebhook
    form.channel = data.channel
    form.webhookUrl = ''
    showWebhook.value = false
    ElMessage.success('通知设置已保存')
  } catch {
    // Error toast is handled by the shared API interceptor.
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  loadPreference()
  loadInboxPreference()
})
</script>

<style scoped>
.notification-settings-page {
  width: min(680px, 100%);
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--aw-divider-soft);
}

.page-title {
  margin: 0 0 8px;
  color: var(--aw-ink);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0;
}

.page-desc {
  margin: 0;
  color: var(--aw-ink-muted-48);
  font-size: 13px;
  line-height: 1.5;
}

.loading-state {
  padding: 48px 0;
  color: var(--aw-ink-muted-48);
  font-size: 13px;
}

.settings-section {
  padding: 24px 0;
  border-bottom: 1px solid var(--aw-divider-soft);
}

.field-label {
  display: block;
  margin-bottom: 10px;
  color: var(--aw-ink);
  font-size: 13px;
  font-weight: 500;
}

.channel-control {
  width: 280px;
  max-width: 100%;
}

.webhook-section :deep(.el-input) {
  max-width: 620px;
}

.input-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--aw-ink-muted-48);
  cursor: pointer;
}

.configured-hint,
.field-error {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.configured-hint {
  color: var(--aw-success);
}

.field-error {
  color: var(--aw-danger);
}

.page-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 24px;
}

.section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.field-desc {
  margin: 0;
  color: var(--aw-ink-muted-48);
  font-size: 12px;
  line-height: 1.6;
}

.inbox-kind-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 1px solid var(--aw-divider-soft);
}

.inbox-kind-label {
  font-size: 13px;
  color: var(--aw-ink);
}

.inbox-kind-hint {
  max-width: 280px;
  font-size: 12px;
  line-height: 1.5;
  text-align: right;
  color: var(--aw-ink-muted-48);
}

.inbox-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 16px;
}

.primary-btn,
.secondary-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 34px;
  padding: 7px 14px;
  border-radius: var(--aw-radius-xs);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

.primary-btn {
  border: 1px solid var(--aw-primary);
  background: var(--aw-primary);
  color: var(--aw-on-primary);
}

.secondary-btn {
  border: 1px solid var(--aw-hairline);
  background: var(--aw-canvas);
  color: var(--aw-ink);
}

.primary-btn:disabled,
.secondary-btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

@media (max-width: 640px) {
  .page-header {
    gap: 16px;
  }

  .page-actions {
    flex-wrap: wrap;
  }

  .primary-btn,
  .secondary-btn {
    flex: 1 1 180px;
  }
}
</style>
