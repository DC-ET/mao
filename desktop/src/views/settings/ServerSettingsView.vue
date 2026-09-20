<template>
  <div class="server-page">
    <div class="page-header">
      <h1 class="page-title">服务器</h1>
      <p class="page-desc">查看当前桌面客户端连接的 Mao 站点；切换服务器后将自动登出并重新加载。</p>
    </div>

    <div class="server-card">
      <div v-if="!isElectron" class="server-tip">
        当前为浏览器访问，服务器地址由部署环境决定，无需在此配置。
        <div class="server-current">当前站点：{{ browserOrigin }}</div>
      </div>

      <template v-else>
        <el-form label-position="top" class="server-form">
          <el-form-item label="服务器地址">
            <el-input v-model="form.serverBaseUrl" placeholder="https://mao.example.com" :disabled="loading || envOverride" />
            <div class="field-hint">支持站点根 / /api / /api/v1，保存时自动归一化。</div>
          </el-form-item>

          <el-form-item label="自动更新源">
            <el-select v-model="form.updateFeedMode" style="width: 100%" :disabled="loading || envOverride">
              <el-option label="跟随当前服务器" value="follow-site" />
              <el-option label="使用安装包内置地址" value="package-default" />
              <el-option label="关闭自动更新" value="disabled" />
            </el-select>
          </el-form-item>

          <el-form-item>
            <el-checkbox v-model="form.allowHttp" :disabled="loading || envOverride">
              允许 HTTP（仅内网，有安全风险）
            </el-checkbox>
          </el-form-item>
        </el-form>

        <div v-if="metaText" class="server-meta">{{ metaText }}</div>
        <div v-if="envOverride" class="server-tip">
          当前客户端通过环境变量 <code>MAO_DESKTOP_SERVER_URL</code> 锁定服务器，界面不可修改。
        </div>

        <div class="server-actions">
          <el-button :loading="probing" @click="probeOnly">检测连通性</el-button>
          <el-button type="primary" :loading="saving" :disabled="envOverride" @click="save">
            保存并切换
          </el-button>
        </div>
        <div v-if="message" class="server-msg" :class="messageType">{{ message }}</div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { isElectronClient } from '../../utils/platform'

type ServerUpdateFeedMode = 'follow-site' | 'package-default' | 'disabled'

const isElectron = isElectronClient()
const browserOrigin = typeof window !== 'undefined' ? window.location.origin : ''

const loading = ref(false)
const saving = ref(false)
const probing = ref(false)
const envOverride = ref(false)
const message = ref('')
const messageType = ref<'ok' | 'error'>('ok')
const currentHostKey = ref('')
const appVersion = ref('')
const updateFeedLabel = ref('')

const form = reactive({
  serverBaseUrl: '',
  updateFeedMode: 'follow-site' as ServerUpdateFeedMode,
  allowHttp: false,
})

const metaText = computed(() => {
  const parts: string[] = []
  if (appVersion.value) parts.push(`壳版本 ${appVersion.value}`)
  if (currentHostKey.value) parts.push(`命名空间 ${currentHostKey.value}`)
  if (updateFeedLabel.value) parts.push(`更新源 ${updateFeedLabel.value}`)
  return parts.join(' · ')
})

function setMessage(text: string, type: 'ok' | 'error' = 'ok') {
  message.value = text
  messageType.value = type
}

async function load() {
  if (!isElectron || !window.electronAPI?.serverConfig) return
  loading.value = true
  try {
    const info = await window.electronAPI.serverConfig.get()
    form.serverBaseUrl = info.serverBaseUrl || ''
    form.updateFeedMode = info.updateFeedMode || 'follow-site'
    form.allowHttp = !!info.allowHttp
    envOverride.value = !!info.envOverride
    currentHostKey.value = info.hostKey || ''
    appVersion.value = info.appVersion || ''
    updateFeedLabel.value = info.updateFeed?.url || info.updateFeed?.mode || ''
    setMessage('')
  } catch (e) {
    setMessage((e as Error)?.message || '读取服务器配置失败', 'error')
  } finally {
    loading.value = false
  }
}

async function probeOnly() {
  if (!window.electronAPI?.serverConfig) return
  probing.value = true
  setMessage('正在检测…')
  try {
    const result = await window.electronAPI.serverConfig.probe(form.serverBaseUrl, {
      allowHttp: form.allowHttp,
    })
    if (result.ok) {
      setMessage(`检测通过：${result.baseUrl}${result.detail ? `（${result.detail}）` : ''}`, 'ok')
    } else {
      setMessage(result.error || '检测失败', 'error')
    }
  } catch (e) {
    setMessage((e as Error)?.message || '检测失败', 'error')
  } finally {
    probing.value = false
  }
}

async function save() {
  if (!window.electronAPI?.serverConfig) return
  const target = form.serverBaseUrl.trim()
  if (!target) {
    setMessage('请填写服务器地址', 'error')
    return
  }

  try {
    await ElMessageBox.confirm(
      '切换服务器将清除本机登录态，并重新加载对应站点。LOCAL 任务数据会按服务器隔离。确认继续？',
      '切换服务器',
      {
        type: 'warning',
        confirmButtonText: '切换',
        cancelButtonText: '取消',
      }
    )
  } catch {
    return
  }

  saving.value = true
  setMessage('正在切换…')
  try {
    const result = await window.electronAPI.serverConfig.set({
      serverBaseUrl: target,
      updateFeedMode: form.updateFeedMode,
      allowHttp: form.allowHttp,
    })
    if (result?.ok) {
      ElMessage.success(`已切换到 ${result.serverBaseUrl}`)
      setMessage(`已切换到 ${result.serverBaseUrl}`, 'ok')
      // 主进程会 loadURL 目标站；此处保留成功提示即可
    } else {
      setMessage(result?.error || '切换失败', 'error')
    }
  } catch (e) {
    setMessage((e as Error)?.message || '切换失败', 'error')
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  void load()
})
</script>

<style scoped>
.server-page {
  max-width: 560px;
}

.page-header {
  margin-bottom: 20px;
}

.page-title {
  margin: 0 0 8px;
  color: var(--aw-ink);
  font-size: 20px;
  font-weight: 600;
}

.page-desc {
  margin: 0;
  color: var(--aw-ink-muted);
  font-size: 13px;
  line-height: 1.5;
}

.server-card {
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-md);
  padding: 24px;
}

.server-form :deep(.el-form-item__label) {
  font-size: 13px;
  line-height: 20px;
}

.field-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--aw-ink-muted);
  line-height: 1.45;
}

.server-meta {
  margin-top: 4px;
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--aw-ink-muted);
}

.server-tip {
  font-size: 13px;
  color: var(--aw-ink-muted);
  line-height: 1.55;
}

.server-current {
  margin-top: 8px;
  color: var(--aw-ink);
}

.server-actions {
  margin-top: 8px;
  display: flex;
  gap: 10px;
}

.server-msg {
  margin-top: 12px;
  font-size: 13px;
  line-height: 1.45;
}

.server-msg.ok {
  color: var(--aw-primary, #0066cc);
}

.server-msg.error {
  color: var(--aw-danger, #c62828);
}
</style>
