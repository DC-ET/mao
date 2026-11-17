<template>
  <div class="host-status-view">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>主机状态</span>
          <div class="header-actions">
            <span class="card-hint">CPU 和内存打开本页后每秒采样，只保留最近 5 分钟。自动刷新只作用于硬盘、容器和进程，默认关闭。不含远程数据库。硬盘同一挂载点只计一次；容器只计这台机器上的 mao 运行时，未在册是进程重启后留下的残留</span>
            <span v-if="lastUpdatedText" class="card-hint">更新于 {{ lastUpdatedText }}</span>
            <span class="auto-refresh-label">自动刷新</span>
            <el-select
              v-model="autoRefreshMs"
              class="auto-refresh-select"
              :class="{ 'is-on': autoRefreshMs > 0 }"
              aria-label="自动刷新间隔"
            >
              <el-option
                v-for="opt in AUTO_REFRESH_OPTIONS"
                :key="opt.value"
                :label="opt.label"
                :value="opt.value"
              />
            </el-select>
            <el-button :loading="loading" aria-label="刷新" title="刷新" @click="fetchVo">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </div>
        </div>
      </template>

      <el-skeleton v-if="vo == null && trendPoints.length === 0 && loading" :rows="6" animated />
      <el-alert v-else-if="vo == null && trendPoints.length === 0" type="error" :closable="false" show-icon :title="loadError || '主机状态暂时读不到'">
        <el-button size="small" @click="fetchVo">重试</el-button>
      </el-alert>
      <template v-else>
        <div v-if="vo" class="host-meta">{{ vo.hostname }} · {{ platformLabel(vo.platform) }} · 开机 {{ formatUptime(vo.uptimeSeconds) }}</div>

        <div class="trend-grid">
          <section class="trend-card">
            <div class="metric-label">CPU</div>
            <div class="metric-value" :class="levelClass(cpu?.usagePercent)">
              {{ cpu == null || cpu.usagePercent == null ? '采样中' : formatPercent(cpu.usagePercent) }}
            </div>
            <template v-if="cpu">
              <div class="metric-sub">{{ cpu.cores }} 核 · 负载 {{ formatLoad(cpu.load1, cpu.load5, cpu.load15) }}</div>
              <div class="metric-note">负载为 1 / 5 / 15 分钟</div>
              <div v-if="cpu.iowaitPercent != null" class="metric-note">等待磁盘 {{ formatPercent(cpu.iowaitPercent) }}</div>
            </template>
            <BaseChart :option="cpuTrendOption" :height="180" :empty="trendPoints.length === 0" empty-text="正在采样" />
          </section>
          <section class="trend-card">
            <div class="metric-label">内存</div>
            <div class="metric-value" :class="levelClass(memory?.usagePercent)">
              {{ memory == null ? '采样中' : formatPercent(memory.usagePercent) }}
            </div>
            <template v-if="memory">
              <div class="metric-sub">已用 {{ formatSize(memory.usedBytes) }} / 共 {{ formatSize(memory.totalBytes) }}</div>
              <div class="metric-sub">可用 {{ formatSize(memory.availableBytes) }} · {{ memoryHint(memorySource) }}</div>
              <div v-if="memory.swapTotalBytes != null && memory.swapUsedBytes != null" class="metric-note">
                交换区 已用 {{ formatSize(memory.swapUsedBytes) }} / 共 {{ formatSize(memory.swapTotalBytes) }}
              </div>
            </template>
            <BaseChart :option="memoryTrendOption" :height="180" :empty="trendPoints.length === 0" empty-text="正在采样" />
          </section>
        </div>
        <div class="metric-note trend-footnote">打开本页后每秒各记一个点，只保留最近 5 分钟。离开页面即停止，不写入数据库</div>

        <div v-if="vo" class="metric-grid">

          <section class="metric-card">
            <div class="metric-label">后端进程</div>
            <div class="metric-value">{{ formatSize(vo.process.rssBytes) }}</div>
            <div class="metric-sub">常驻内存 · 已运行 {{ formatUptime(vo.process.uptimeSeconds) }}</div>
            <div class="metric-sub">堆 {{ formatSize(vo.process.heapUsedBytes) }} / {{ formatSize(vo.process.heapTotalBytes) }}</div>
            <div class="metric-sub">事件循环 {{ vo.process.eventLoopDelayMs == null ? '采样中' : formatDelay(vo.process.eventLoopDelayMs) }}</div>
            <div v-if="vo.process.openFds != null" class="metric-sub" :class="levelClass(fdPercent)">
              文件描述符 {{ formatCount(vo.process.openFds) }}<template v-if="vo.process.fdLimit != null"> / {{ formatCount(vo.process.fdLimit) }}</template>
            </div>
          </section>

          <section class="metric-card">
            <div class="metric-label">容器</div>
            <template v-if="vo.containers.available">
              <div class="metric-value">{{ vo.containers.running }}</div>
              <div class="metric-sub">运行中 · 共 {{ vo.containers.total }}</div>
              <div class="metric-sub">已停止 {{ vo.containers.stopped }} · 未在册 {{ vo.containers.untracked }} · 有任务 {{ vo.containers.busy }}</div>
              <template v-if="vo.dockerDisk.available">
                <div class="metric-sub">镜像 {{ formatSize(vo.dockerDisk.imagesBytes) }} · 可回收 {{ formatSize(vo.dockerDisk.imagesReclaimableBytes) }}</div>
                <div class="metric-sub">卷 {{ formatSize(vo.dockerDisk.volumesBytes) }} · 可回收 {{ formatSize(vo.dockerDisk.volumesReclaimableBytes) }}</div>
                <div class="metric-sub">构建缓存 {{ formatSize(vo.dockerDisk.buildCacheBytes) }} · 可回收 {{ formatSize(vo.dockerDisk.buildCacheReclaimableBytes) }}</div>
              </template>
              <div v-else class="metric-note">{{ vo.dockerDisk.reason || 'Docker 磁盘占用读不到' }}</div>
            </template>
            <template v-else>
              <div class="metric-value is-muted">不可用</div>
              <div class="metric-sub">{{ vo.containers.reason || '无法连接 Docker' }}</div>
            </template>
            <el-button v-if="canOpenSettings" class="settings-link" link type="primary" @click="router.push('/settings')">
              在系统设置中管理容器
            </el-button>
          </section>
        </div>

        <div v-if="vo" class="disk-section">
          <div class="disk-head">
            <span class="disk-title">硬盘</span>
            <span v-if="vo.diskIo.readBytesPerSec != null && vo.diskIo.writeBytesPerSec != null" class="metric-note">
              读 {{ formatSize(vo.diskIo.readBytesPerSec) }}/s · 写 {{ formatSize(vo.diskIo.writeBytesPerSec) }}/s
            </span>
          </div>
          <div v-if="vo.disks.length === 0" class="metric-note">没有读到磁盘占用</div>
          <div v-for="disk in vo.disks" :key="disk.mount" class="disk-row">
            <div class="disk-head">
              <span class="disk-label">{{ disk.label }}</span>
              <span class="disk-percent" :class="levelClass(disk.usagePercent)">{{ formatPercent(disk.usagePercent) }}</span>
            </div>
            <el-progress
              :percentage="clampPercent(disk.usagePercent)"
              :color="usageColor"
              :stroke-width="8"
              :show-text="false"
            />
            <div class="metric-note">{{ diskPlace(disk) }} · 已用 {{ formatSize(disk.usedBytes) }} / 共 {{ formatSize(disk.totalBytes) }} · 可用 {{ formatSize(disk.availableBytes) }}</div>
            <div v-if="disk.inodeUsagePercent != null" class="metric-note" :class="levelClass(disk.inodeUsagePercent)">
              inode {{ formatPercent(disk.inodeUsagePercent) }}<template v-if="disk.inodeUsed != null && disk.inodeTotal != null"> · {{ formatCount(disk.inodeUsed) }} / {{ formatCount(disk.inodeTotal) }}</template>
            </div>
          </div>
        </div>
      </template>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Refresh } from '@element-plus/icons-vue'
import type { HostStatusVo, HostTrendSample } from '@mao/contracts'
import BaseChart from '../../components/BaseChart.vue'
import { api } from '../../api'
import { useAuthStore } from '../../stores/auth'
import { formatDateTime } from '../../utils/datetime'
import { formatSize } from '../session/utils/file-format'
import { appendHostTrend, HOST_TREND_INTERVAL_MS, hostTrendOption, type HostTrendPoint } from './hostTrend'
import {
  clampPercent,
  diskPlace,
  formatCount,
  formatDelay,
  formatLoad,
  formatPercent,
  formatUptime,
  memoryHint,
  platformLabel,
  usageColor,
  usageLevel
} from './hostFormat'

/** 0=关闭。只作用于硬盘、容器和进程，不持久化，默认关闭。CPU 和内存另按每秒采样。 */
const AUTO_REFRESH_OPTIONS = [
  { label: '关闭', value: 0 },
  { label: '5s', value: 5_000 },
  { label: '10s', value: 10_000 },
  { label: '30s', value: 30_000 },
  { label: '1m', value: 60_000 }
] as const

const router = useRouter()
const auth = useAuthStore()
const canOpenSettings = computed(() => auth.hasPermission('settings:read'))

const loading = ref(false)
const loadError = ref('')
const vo = ref<HostStatusVo | null>(null)
const latestTrend = ref<HostTrendSample | null>(null)
const trendPoints = ref<HostTrendPoint[]>([])
const lastUpdated = ref<Date | null>(null)
const autoRefreshMs = ref(0)
let snapshotTimer: ReturnType<typeof setInterval> | null = null
let trendTimer: ReturnType<typeof setInterval> | null = null
let trendInFlight = false

const lastUpdatedText = computed(() => (lastUpdated.value ? formatDateTime(lastUpdated.value.toISOString()) : ''))
const cpu = computed(() => latestTrend.value?.cpu ?? vo.value?.cpu ?? null)
const memory = computed(() => latestTrend.value?.memory ?? vo.value?.memory ?? null)
const memorySource = computed(() => latestTrend.value?.memorySource ?? vo.value?.memorySource ?? 'os')
const cpuTrendOption = computed(() => hostTrendOption(trendPoints.value, 'cpu'))
const memoryTrendOption = computed(() => hostTrendOption(trendPoints.value, 'memory'))

const fdPercent = computed(() => {
  const open = vo.value?.process.openFds
  const limit = vo.value?.process.fdLimit
  if (open == null || limit == null || limit <= 0) return null
  return (open / limit) * 100
})

function levelClass(percent: number | null | undefined): string {
  const level = usageLevel(percent)
  return level === 'normal' ? '' : `is-${level}`
}

async function fetchVo() {
  loading.value = true
  try {
    const { data } = await api.get<HostStatusVo>('/statistics/host', { skipErrorToast: true })
    vo.value = data
    lastUpdated.value = new Date()
    loadError.value = ''
  } catch {
    if (vo.value == null) loadError.value = '主机状态暂时读不到，请稍后重试'
  } finally {
    loading.value = false
  }
}

async function fetchTrend() {
  if (trendInFlight) return
  trendInFlight = true
  try {
    const { data } = await api.get<HostTrendSample>('/statistics/host/trend', { skipErrorToast: true })
    latestTrend.value = data
    trendPoints.value = appendHostTrend(trendPoints.value, {
      at: data.sampledAt,
      cpu: data.cpu.usagePercent,
      memory: data.memory.usagePercent
    })
    lastUpdated.value = new Date(data.sampledAt)
  } catch {
    // 折线留在上一个点；整页读不到仍由快照请求提示
  } finally {
    trendInFlight = false
  }
}

function startTrendTimer() {
  if (trendTimer == null) trendTimer = setInterval(() => void fetchTrend(), HOST_TREND_INTERVAL_MS)
}

function startSnapshotTimer() {
  if (snapshotTimer != null) {
    clearInterval(snapshotTimer)
    snapshotTimer = null
  }
  if (autoRefreshMs.value <= 0) return
  snapshotTimer = setInterval(() => {
    if (document.hidden || loading.value) return
    void fetchVo()
  }, autoRefreshMs.value)
}

function stopTimers() {
  if (snapshotTimer != null) {
    clearInterval(snapshotTimer)
    snapshotTimer = null
  }
  if (trendTimer != null) {
    clearInterval(trendTimer)
    trendTimer = null
  }
}

watch(autoRefreshMs, startSnapshotTimer)

onMounted(() => {
  void fetchVo()
  void fetchTrend()
  startTrendTimer()
  startSnapshotTimer()
})

onActivated(() => {
  void fetchVo()
  void fetchTrend()
  startTrendTimer()
  startSnapshotTimer()
})

onDeactivated(stopTimers)
onBeforeUnmount(stopTimers)
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}

.header-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex: 1;
  flex-wrap: wrap;
  gap: 12px;
  min-width: 0;
}

.card-hint {
  font-size: 12px;
  color: var(--mao-muted);
  line-height: 1.5;
}

.header-actions .card-hint:first-child {
  flex: 1 1 280px;
}

.auto-refresh-label {
  font-size: 13px;
  color: var(--mao-muted);
}

.auto-refresh-select {
  width: 88px;
}

.auto-refresh-select.is-on :deep(.el-select__wrapper) {
  box-shadow: 0 0 0 1px var(--mao-accent) inset;
}

.auto-refresh-select :deep(.el-select__selected-item) {
  font-variant-numeric: tabular-nums;
}

.host-meta {
  margin-bottom: 16px;
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.trend-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.trend-card {
  padding: 16px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  min-width: 0;
}

.trend-footnote {
  margin: 8px 0 16px;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.metric-card {
  padding: 16px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  min-width: 0;
}

.metric-label {
  font-size: 13px;
  color: var(--mao-muted);
}

.metric-value {
  margin: 6px 0 10px;
  font-size: 28px;
  font-weight: 600;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}

.metric-value.is-warm,
.disk-percent.is-warm,
.metric-sub.is-warm,
.metric-note.is-warm {
  color: var(--el-color-warning);
}

.metric-value.is-hot,
.disk-percent.is-hot,
.metric-sub.is-hot,
.metric-note.is-hot {
  color: var(--el-color-danger);
}

.metric-value.is-muted {
  font-size: 22px;
  color: var(--mao-muted);
}

.metric-sub {
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.5;
}

.metric-note {
  margin-top: 4px;
  font-size: 12px;
  color: var(--mao-muted);
  line-height: 1.5;
}

.settings-link {
  margin-top: 8px;
  padding-left: 0;
}

.disk-section {
  margin-top: 20px;
}

.disk-title {
  font-size: 14px;
  font-weight: 600;
}

.disk-row + .disk-row {
  margin-top: 14px;
}

.disk-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 6px;
}

.disk-label {
  font-size: 13px;
}

.disk-percent {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 700px) {
  .card-header {
    flex-direction: column;
    align-items: stretch;
  }

  .trend-grid,
  .metric-grid {
    grid-template-columns: 1fr;
  }
}
</style>
