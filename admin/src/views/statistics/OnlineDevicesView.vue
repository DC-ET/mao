<template>
  <div class="online-devices-view">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>在线设备</span>
          <div class="header-actions">
            <span class="card-hint">当前 WS 在线连接实时快照（{{ REFRESH_INTERVAL_MS / 1000 }}s 自动刷新）；连接数 ≠ 设备数：同机桌面/CLI 按设备去重，浏览器多开各自计一条且不计入设备数</span>
            <span v-if="lastUpdatedText" class="card-hint">更新于 {{ lastUpdatedText }}</span>
            <el-button :loading="loading" @click="fetchVo">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </div>
        </div>
      </template>

      <div class="stat-cards">
        <div class="stat-card">
          <div class="stat-value">{{ vo?.total.connections ?? 0 }}</div>
          <div class="stat-label">在线连接</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ vo?.total.users ?? 0 }}</div>
          <div class="stat-label">在线用户</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ vo?.total.devices ?? 0 }}</div>
          <div class="stat-label">去重设备</div>
        </div>
        <div class="stat-card stat-card-types">
          <div class="type-tags">
            <el-tag v-for="c in clientTypeCounts" :key="c.type" size="small" :type="c.tagType">{{ c.label }} {{ c.count }}</el-tag>
          </div>
          <div class="stat-label">按客户端类型</div>
        </div>
      </div>

      <el-table :data="rows" v-loading="initialLoading" stripe>
        <template #empty>
          <el-empty description="当前没有在线连接（管理后台自身不连 WS，不会出现在列表中）" :image-size="60" />
        </template>
        <el-table-column label="用户" min-width="150" show-overflow-tooltip>
          <template #default="{ row }">
            <span>{{ row.displayName || row.username }}</span>
            <span v-if="row.displayName" class="muted">（{{ row.username }}）</span>
          </template>
        </el-table-column>
        <el-table-column label="客户端类型" width="130">
          <template #default="{ row }">
            <el-tag size="small" :type="row.tagType">{{ row.typeLabel }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="连接时长" width="120">
          <template #default="{ row }">{{ row.durationText }}</template>
        </el-table-column>
        <el-table-column label="认证到期" width="170">
          <template #default="{ row }">{{ row.expiresText }}</template>
        </el-table-column>
        <el-table-column label="额外信息" min-width="280" class-name="extra-info-col">
          <template #header>
            <span title="每项都带名称。版本是客户端连上时自报的：桌面是已安装的壳版本，安卓是 APK 版本，浏览器是当前页面版本，终端 CLI 是 mao-agent 版本，页面嵌入是 SDK 版本。桌面客户端和终端 CLI 还有设备名、平台和设备 ID，点击设备 ID 可复制。公司 SSO 登录会有「凭据」。都没有时为 -">额外信息</span>
          </template>
          <template #default="{ row }">
            <div v-if="row.clientVersion || row.device || row.authSourceLabel" class="extra-info">
              <template v-if="row.clientVersion">
                <span class="extra-info-label">版本</span>
                <span class="extra-info-value">{{ row.clientVersion }}</span>
              </template>
              <template v-if="row.device">
                <span class="extra-info-label">设备名</span>
                <span class="extra-info-value">{{ row.device.name || '-' }}</span>
                <span class="extra-info-label">平台</span>
                <span class="extra-info-value">{{ row.device.platform || '-' }}</span>
                <span class="extra-info-label">设备 ID</span>
                <span class="extra-info-value">
                  <el-tooltip :content="row.device.id" placement="top" :show-after="300" :enterable="false">
                    <button type="button" class="device-id" title="点击复制设备 ID" @click="copyDeviceId(row.device.id)">{{ row.device.id }}</button>
                  </el-tooltip>
                </span>
              </template>
              <template v-if="row.authSourceLabel">
                <span class="extra-info-label" title="登录凭据类型">凭据</span>
                <span class="extra-info-value">{{ row.authSourceLabel }}</span>
              </template>
            </div>
            <span v-else class="muted">-</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import type { OnlineDeviceConnection, OnlineDevicesVo, WsClientType } from '@mao/contracts'
import { api } from '../../api'
import { formatDateTime } from '../../utils/datetime'
import { wsClientTypeLabel } from '../../utils/wsClientTypeLabels'

const REFRESH_INTERVAL_MS = 15000

/** 类型标签配色。键类型吃契约联合穷尽（与汉化表同机制）。 */
const TAG_TYPES: Record<WsClientType, 'success' | 'warning' | 'info' | 'primary' | 'danger'> = {
  electron: 'success',
  android: 'primary',
  cli: 'warning',
  browser: 'info',
  embed: 'danger'
}

interface ConnectionRow {
  key: string
  username: string
  displayName: string | null
  typeLabel: string
  tagType: 'success' | 'warning' | 'info' | 'primary' | 'danger'
  device: OnlineDeviceConnection['device']
  authSourceLabel: string | null
  clientVersion: string | null
  durationText: string
  expiresText: string
}

const loading = ref(false)
const vo = ref<OnlineDevicesVo | null>(null)
const lastUpdated = ref<Date | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

const initialLoading = computed(() => loading.value && vo.value == null)

const rows = computed<ConnectionRow[]>(() => {
  const now = Date.now()
  const list: ConnectionRow[] = []
  for (const user of vo.value?.users ?? []) {
    for (const conn of user.connections) {
      list.push({
        key: `${user.userId}:${conn.wsSessionId}`,
        username: user.username,
        displayName: user.displayName,
        typeLabel: wsClientTypeLabel(conn.clientType),
        tagType: TAG_TYPES[conn.clientType],
        device: conn.device,
        authSourceLabel: connectionAuthLabel(conn.authSource),
        clientVersion: conn.clientVersion,
        durationText: formatDuration(now - conn.connectedAt),
        expiresText: conn.authExpiresAt != null ? formatEpoch(conn.authExpiresAt) : '-'
      })
    }
  }
  return list
})

const clientTypeCounts = computed(() => {
  const by = vo.value?.byClientType
  if (!by) return []
  return (Object.keys(by) as WsClientType[]).map((type) => ({
    type,
    label: wsClientTypeLabel(type),
    count: by[type],
    tagType: TAG_TYPES[type]
  }))
})

const lastUpdatedText = computed(() => (lastUpdated.value ? formatEpoch(lastUpdated.value.getTime()) : ''))

/** 连接凭据类型。普通登录的令牌不带这个标记，返回 null，额外信息里不占一行。 */
function connectionAuthLabel(source: string | null): string | null {
  if (!source) return null
  if (source === 'company_sso') return '公司 SSO'
  return source
}

/** epoch ms → 北京时间（与 utils/datetime.ts 同一展示口径，这里是数字入参的窄封装）。 */
function formatEpoch(ms: number): string {
  if (!Number.isFinite(ms)) return '-'
  return formatDateTime(new Date(ms).toISOString())
}

/** 连接时长人性化展示；负值（时钟偏差/重连竞态）按刚刚处理。 */
function formatDuration(ms: number): string {
  if (ms < 0) return '刚刚'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}

async function fetchVo() {
  loading.value = true
  try {
    // 轮询失败静默保留旧数据（skipErrorToast 避免每 15s 弹红条）；陈旧程度由「更新于」暴露
    const { data } = await api.get<OnlineDevicesVo>('/statistics/online-devices', { skipErrorToast: true })
    vo.value = data
    lastUpdated.value = new Date()
  } catch { /* 保留旧数据 */ } finally {
    loading.value = false
  }
}

async function copyDeviceId(id: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(id)
    } else {
      copyByExecCommand(id)
    }
    ElMessage.success('设备 ID 已复制')
  } catch {
    try {
      copyByExecCommand(id)
      ElMessage.success('设备 ID 已复制')
    } catch {
      ElMessage.error('复制失败，请手动选择复制')
    }
  }
}

/** clipboard API 不可用或被拒绝时的兜底（参照会话详情复制工作区路径）。 */
function copyByExecCommand(text: string) {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  const ok = document.execCommand('copy')
  document.body.removeChild(textarea)
  if (!ok) throw new Error('copy failed')
}

function startTimer() {
  if (timer == null) timer = setInterval(fetchVo, REFRESH_INTERVAL_MS)
}

function stopTimer() {
  if (timer != null) {
    clearInterval(timer)
    timer = null
  }
}

onMounted(() => {
  void fetchVo()
  startTimer()
})

// keepAlive：页面切走时停轮询，切回立即刷一次并恢复（router meta.keepAlive: true）
onActivated(() => {
  void fetchVo()
  startTimer()
})

onDeactivated(stopTimer)
onBeforeUnmount(stopTimer)
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.card-hint {
  font-size: 12px;
  color: var(--mao-muted);
}

.stat-cards {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.stat-card {
  min-width: 140px;
  padding: 12px 16px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  flex: 0 0 auto;
}

.stat-card-types {
  flex: 1 1 220px;
}

.stat-value {
  font-size: 24px;
  font-weight: 600;
}

.stat-label {
  margin-top: 4px;
  font-size: 12px;
  color: var(--mao-muted);
}

.type-tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  min-height: 24px;
  align-items: center;
}

:deep(.extra-info-col .cell) {
  overflow: hidden;
}

.extra-info {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  column-gap: 8px;
  row-gap: 2px;
  align-items: center;
  min-width: 0;
  max-width: 100%;
}

.extra-info-label {
  color: var(--mao-muted);
  white-space: nowrap;
}

.extra-info-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.extra-info-value :deep(.el-tooltip__trigger) {
  display: block;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
}

.device-id {
  display: block;
  width: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: inherit;
  line-height: inherit;
  color: inherit;
  text-align: left;
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
}

.device-id:hover {
  color: var(--el-color-primary);
}

.muted {
  color: var(--mao-muted);
}
</style>
