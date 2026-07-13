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
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { Check, CircleCheck, Connection, Hide, View } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import {
  getTaskNotificationPreference,
  saveTaskNotificationPreference,
  testTaskNotification,
  type NotificationChannel,
  type TaskNotificationPreference
} from '../../api'

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

onMounted(loadPreference)
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
