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
        <!-- 当前连接状态 -->
        <div class="server-status" :class="statusState">
          <span class="dot" />
          <div class="status-main">
            <div class="status-line">
              <span class="status-label">{{ statusLabel }}</span>
              <span class="status-url">{{ form.serverBaseUrl || '—' }}</span>
            </div>
            <div v-if="statusDetail" class="status-detail">{{ statusDetail }}</div>
          </div>
          <el-button size="small" :loading="checkingCurrent" @click="probeCurrent">重新检测</el-button>
        </div>
        <div v-if="envOverride" class="server-tip warn">
          当前客户端通过环境变量 <code>MAO_DESKTOP_SERVER_URL</code> 锁定服务器，界面不可修改。
        </div>

        <!-- 连接过的服务器：一键切换 -->
        <div v-if="history.length" class="server-history">
          <div class="history-title">连接过的服务器</div>
          <div
            v-for="entry in history"
            :key="entry.serverBaseUrl"
            class="history-row"
            :class="{ current: isCurrent(entry) }"
          >
            <div class="history-avatar" :style="{ background: avatarColor(entry.serverBaseUrl) }">
              {{ hostOf(entry.serverBaseUrl).charAt(0).toUpperCase() }}
            </div>
            <div class="history-info">
              <div class="history-host">
                <span class="name">{{ hostOf(entry.serverBaseUrl) }}</span>
                <span v-if="entry.allowHttp" class="http-tag">HTTP</span>
              </div>
              <div class="history-sub" :title="entry.serverBaseUrl">
                {{ entry.serverBaseUrl }}{{ entry.lastConnectedAt ? ` · ${formatRelative(entry.lastConnectedAt)}` : '' }}
              </div>
            </div>
            <span v-if="isCurrent(entry)" class="current-badge">当前</span>
            <template v-else>
              <el-button
                size="small"
                :loading="switchingUrl === entry.serverBaseUrl"
                :disabled="envOverride"
                @click="switchTo(entry)"
              >
                切换
              </el-button>
              <el-button size="small" text type="danger" :disabled="envOverride" @click="removeEntry(entry)">
                删除
              </el-button>
            </template>
          </div>
        </div>

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
type ProbeState = 'unconfigured' | 'checking' | 'ok' | 'error' | 'unknown'

const isElectron = isElectronClient()
const browserOrigin = typeof window !== 'undefined' ? window.location.origin : ''

const loading = ref(false)
const saving = ref(false)
const probing = ref(false)
const checkingCurrent = ref(false)
const envOverride = ref(false)
const message = ref('')
const messageType = ref<'ok' | 'error'>('ok')
const currentHostKey = ref('')
const appVersion = ref('')
const updateFeedLabel = ref('')
const configured = ref(false)
const probeState = ref<ProbeState>('unknown')
const probeDetail = ref('')
const history = ref<ServerConfigHistoryEntry[]>([])
const switchingUrl = ref('')

const form = reactive({
  serverBaseUrl: '',
  updateFeedMode: 'follow-site' as ServerUpdateFeedMode,
  allowHttp: false,
})

const AVATAR_PALETTE = ['#0066cc', '#6c5ce7', '#0097a7', '#2e7d32', '#b26a00', '#c62828', '#5c6bc0']

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

/** 与主进程 serverHostKey 同口径：host 或 host_port */
function hostKeyOf(url: string): string {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname || 'default'
    return parsed.port ? `${host}_${parsed.port}` : host
  } catch {
    return 'default'
  }
}

function avatarColor(url: string): string {
  const host = hostOf(url)
  return AVATAR_PALETTE[(host.charCodeAt(0) || 0) % AVATAR_PALETTE.length]
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 昨天 HH:mm / MM-DD HH:mm / YYYY-MM-DD */
function formatRelative(iso: string | null): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const diff = Date.now() - then
  if (diff < 0) return ''
  const min = 60000
  const pad = (n: number) => String(n).padStart(2, '0')
  const d = new Date(then)
  if (diff < min) return '刚刚'
  if (diff < 60 * min) return `${Math.floor(diff / min)} 分钟前`
  if (diff < 24 * 60 * min) return `${Math.floor(diff / (60 * min))} 小时前`
  if (diff < 7 * 24 * 60 * min) return `${Math.floor(diff / (24 * 60 * min))} 天前`
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  if (then >= dayStart.getTime() - 24 * 60 * 60 * min) return `昨天 ${hhmm}`
  if (d.getFullYear() === new Date().getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm}`
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const statusState = computed<ProbeState>(() => {
  if (!configured.value) return 'unconfigured'
  return probeState.value
})

const statusLabel = computed(() => {
  switch (statusState.value) {
    case 'unconfigured': return '尚未配置服务器'
    case 'checking': return '正在检测…'
    case 'ok': return '已连接'
    case 'error': return '无法连接'
    default: return '未检测'
  }
})

const metaText = computed(() => {
  const parts: string[] = []
  if (appVersion.value) parts.push(`壳版本 ${appVersion.value}`)
  if (currentHostKey.value) parts.push(`命名空间 ${currentHostKey.value}`)
  if (updateFeedLabel.value) parts.push(`更新源 ${updateFeedLabel.value}`)
  return parts.join(' · ')
})

const statusDetail = computed(() =>
  [probeDetail.value, metaText.value].filter(Boolean).join(' · ')
)

function isCurrent(entry: ServerConfigHistoryEntry): boolean {
  return hostKeyOf(entry.serverBaseUrl) === currentHostKey.value
}

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
    configured.value = !!info.configured
    currentHostKey.value = info.hostKey || hostKeyOf(info.serverBaseUrl || '')
    appVersion.value = info.appVersion || ''
    updateFeedLabel.value = info.updateFeed?.url || info.updateFeed?.mode || ''
    history.value = Array.isArray(info.history) ? info.history : []
    setMessage('')
    if (configured.value) void probeCurrent()
  } catch (e) {
    setMessage((e as Error)?.message || '读取服务器配置失败', 'error')
  } finally {
    loading.value = false
  }
}

async function probeCurrent() {
  if (!window.electronAPI?.serverConfig || !form.serverBaseUrl) return
  checkingCurrent.value = true
  probeState.value = 'checking'
  try {
    const result = await window.electronAPI.serverConfig.probe(form.serverBaseUrl, {
      allowHttp: form.allowHttp,
    })
    if (result.ok) {
      probeState.value = 'ok'
      probeDetail.value = result.detail || '站点可达'
    } else {
      probeState.value = 'error'
      probeDetail.value = result.error || '检测失败'
    }
  } catch (e) {
    probeState.value = 'error'
    probeDetail.value = (e as Error)?.message || '检测失败'
  } finally {
    checkingCurrent.value = false
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

/** 历史一键切换：先探测，host 变化需确认，随后保存并重载 */
async function switchTo(entry: ServerConfigHistoryEntry) {
  if (!window.electronAPI?.serverConfig) return
  const target = entry.serverBaseUrl
  switchingUrl.value = target
  setMessage('正在检测…')
  try {
    const probe = await window.electronAPI.serverConfig.probe(target, { allowHttp: entry.allowHttp })
    if (!probe.ok) {
      setMessage(probe.error || '服务器检测失败', 'error')
      return
    }
    if (hostKeyOf(target) !== currentHostKey.value) {
      try {
        await ElMessageBox.confirm(
          `将切换到 ${target}。切换会清除本机登录态，LOCAL 任务数据按服务器隔离，需要重新登录。确认继续？`,
          '切换服务器',
          { type: 'warning', confirmButtonText: '切换', cancelButtonText: '取消' }
        )
      } catch {
        setMessage('')
        return
      }
    }
    setMessage('正在切换…')
    const result = await window.electronAPI.serverConfig.set({
      serverBaseUrl: target,
      allowHttp: entry.allowHttp,
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
    switchingUrl.value = ''
  }
}

async function removeEntry(entry: ServerConfigHistoryEntry) {
  if (!window.electronAPI?.serverConfig) return
  try {
    await ElMessageBox.confirm(
      `从历史记录中移除 ${entry.serverBaseUrl}？不影响当前正在连接的站点。`,
      '删除历史地址',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    const result = await window.electronAPI.serverConfig.removeHistory(entry.serverBaseUrl)
    if (result?.ok) {
      history.value = Array.isArray(result.history)
        ? result.history
        : history.value.filter((e) => e.serverBaseUrl !== entry.serverBaseUrl)
    } else {
      setMessage(result?.error || '删除失败', 'error')
    }
  } catch (e) {
    setMessage((e as Error)?.message || '删除失败', 'error')
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

/* 当前连接状态 */
.server-status {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-md, 10px);
  background: var(--aw-bg, #fbfbfc);
  margin-bottom: 16px;
}

.server-status .dot {
  flex-shrink: 0;
  width: 9px;
  height: 9px;
  margin-top: 6px;
  border-radius: 50%;
  background: #c7c7cc;
}

.server-status.checking .dot {
  background: #e6a23c;
  animation: server-status-pulse 1.2s ease-in-out infinite;
}

.server-status.ok .dot { background: #2e7d32; }
.server-status.error .dot { background: #c62828; }

@keyframes server-status-pulse {
  50% { opacity: 0.35; }
}

.status-main {
  flex: 1;
  min-width: 0;
}

.status-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.status-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--aw-ink);
}

.status-url {
  font-size: 14px;
  font-weight: 600;
  color: var(--aw-ink);
  word-break: break-all;
}

.status-detail {
  margin-top: 4px;
  font-size: 12px;
  color: var(--aw-ink-muted);
  line-height: 1.5;
  word-break: break-all;
}

/* 历史列表 */
.server-history {
  margin-bottom: 16px;
}

.history-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--aw-ink);
  margin-bottom: 8px;
}

.history-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border: 1px solid var(--aw-divider-soft);
  border-radius: 10px;
  margin-bottom: 8px;
}

.history-row:hover {
  border-color: var(--aw-divider, #d5d5da);
}

.history-row.current {
  background: rgba(0, 102, 204, 0.08);
  border-color: rgba(0, 102, 204, 0.25);
}

.history-avatar {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
}

.history-info {
  flex: 1;
  min-width: 0;
}

.history-host {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--aw-ink);
  min-width: 0;
}

.history-host .name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.http-tag {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  color: #b26a00;
  background: rgba(230, 145, 20, 0.12);
  border-radius: 4px;
  padding: 0 4px;
  line-height: 16px;
}

.history-sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--aw-ink-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.current-badge {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--aw-primary, #0066cc);
  border: 1px solid rgba(0, 102, 204, 0.4);
  border-radius: 999px;
  padding: 2px 8px;
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

.server-tip {
  font-size: 13px;
  color: var(--aw-ink-muted);
  line-height: 1.55;
}

.server-tip.warn {
  color: #b26a00;
  margin-bottom: 12px;
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
