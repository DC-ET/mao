<template>
  <div class="host-status-view">
    <el-card>
      <template #header>
        <div class="card-header">
          <div class="title-block">
            <div class="title-line">
              <span class="title">主机状态</span>
              <span v-if="vo" class="host-meta">{{ vo.hostname }} · {{ platformLabel(vo.platform) }} · 开机 {{ formatUptime(vo.uptimeSeconds) }}</span>
            </div>
            <div class="title-note">
              CPU、内存每秒采样，只留最近 5 分钟，不写入数据库
              <el-tooltip placement="top" :content="samplingHint">
                <el-icon class="hint-info" aria-label="采样说明"><InfoFilled /></el-icon>
              </el-tooltip>
            </div>
          </div>
          <div class="header-actions">
            <span v-if="lastUpdatedText" class="updated">更新于 {{ lastUpdatedText }}</span>
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
        <div class="chart-grid">
          <section class="panel">
            <div class="chart-head">
              <div class="kpi">
                <span class="kpi-label">CPU</span>
                <span class="kpi-value" :class="levelClass(cpu?.usagePercent)">
                  {{ cpu == null || cpu.usagePercent == null ? '采样中' : formatPercent(cpu.usagePercent) }}
                </span>
              </div>
              <dl v-if="cpu" class="facts">
                <div>
                  <dt>核数</dt>
                  <dd>{{ cpu.cores }}</dd>
                </div>
                <div>
                  <dt>负载 1 / 5 / 15 分</dt>
                  <dd>{{ formatLoad(cpu.load1, cpu.load5, cpu.load15) }}</dd>
                </div>
                <div v-if="cpu.iowaitPercent != null">
                  <dt>等待磁盘</dt>
                  <dd :class="levelClass(cpu.iowaitPercent)">{{ formatPercent(cpu.iowaitPercent) }}</dd>
                </div>
              </dl>
            </div>
            <BaseChart :option="cpuTrendOption" :height="148" :empty="trendPoints.length === 0" empty-text="正在采样" />
          </section>

          <section class="panel">
            <div class="chart-head">
              <div class="kpi">
                <span class="kpi-label">内存</span>
                <span class="kpi-value" :class="levelClass(memory?.usagePercent)">
                  {{ memory == null ? '采样中' : formatPercent(memory.usagePercent) }}
                </span>
              </div>
              <dl v-if="memory" class="facts">
                <div>
                  <dt>已用 / 共</dt>
                  <dd>{{ formatSize(memory.usedBytes) }} / {{ formatSize(memory.totalBytes) }}</dd>
                </div>
                <div>
                  <dt>可用</dt>
                  <dd>{{ formatSize(memory.availableBytes) }}<span class="extra">{{ memoryHint(memorySource) }}</span></dd>
                </div>
                <div>
                  <dt>交换区</dt>
                  <dd v-if="memory.swapTotalBytes != null && memory.swapUsedBytes != null">
                    {{ formatSize(memory.swapUsedBytes) }} / {{ formatSize(memory.swapTotalBytes) }}
                  </dd>
                  <dd v-else>无</dd>
                </div>
              </dl>
            </div>
            <BaseChart :option="memoryTrendOption" :height="148" :empty="trendPoints.length === 0" empty-text="正在采样" />
          </section>
        </div>

        <div v-if="vo" class="detail-grid">
          <section class="panel">
            <div class="panel-title">后端进程</div>
            <dl class="stat-strip">
              <div>
                <dt>常驻内存</dt>
                <dd>{{ formatSize(vo.process.rssBytes) }}</dd>
              </div>
              <div>
                <dt>已运行</dt>
                <dd>{{ formatUptime(vo.process.uptimeSeconds) }}</dd>
              </div>
              <div>
                <dt>堆</dt>
                <dd>{{ formatSize(vo.process.heapUsedBytes) }}<span class="extra"> / {{ formatSize(vo.process.heapTotalBytes) }}</span></dd>
              </div>
              <div>
                <dt>事件循环</dt>
                <dd>{{ vo.process.eventLoopDelayMs == null ? '采样中' : formatDelay(vo.process.eventLoopDelayMs) }}</dd>
              </div>
              <div v-if="vo.process.openFds != null">
                <dt>文件描述符</dt>
                <dd :class="levelClass(fdPercent)">
                  {{ formatCount(vo.process.openFds) }}<span v-if="vo.process.fdLimit != null" class="extra"> / {{ formatCount(vo.process.fdLimit) }}</span>
                </dd>
              </div>
            </dl>
          </section>

          <section class="panel">
            <div class="panel-head">
              <span class="panel-title">容器</span>
              <el-button v-if="canOpenSettings" link type="primary" @click="router.push('/settings')">管理</el-button>
            </div>
            <template v-if="vo.containers.available">
              <dl class="stat-strip">
                <div>
                  <dt>运行中</dt>
                  <dd>{{ vo.containers.running }}<span class="extra"> / {{ vo.containers.total }}</span></dd>
                </div>
                <div>
                  <dt>已停止</dt>
                  <dd>{{ vo.containers.stopped }}</dd>
                </div>
                <div>
                  <dt>未在册</dt>
                  <dd>{{ vo.containers.untracked }}</dd>
                </div>
                <div>
                  <dt>有任务</dt>
                  <dd>{{ vo.containers.busy }}</dd>
                </div>
                <template v-if="vo.dockerDisk.available">
                  <div>
                    <dt>镜像</dt>
                    <dd>{{ formatSize(vo.dockerDisk.imagesBytes) }}<span class="extra">可回收 {{ formatSize(vo.dockerDisk.imagesReclaimableBytes) }}</span></dd>
                  </div>
                  <div>
                    <dt>卷</dt>
                    <dd>{{ formatSize(vo.dockerDisk.volumesBytes) }}<span class="extra">可回收 {{ formatSize(vo.dockerDisk.volumesReclaimableBytes) }}</span></dd>
                  </div>
                  <div>
                    <dt>构建缓存</dt>
                    <dd>{{ formatSize(vo.dockerDisk.buildCacheBytes) }}<span class="extra">可回收 {{ formatSize(vo.dockerDisk.buildCacheReclaimableBytes) }}</span></dd>
                  </div>
                </template>
              </dl>
              <p v-if="!vo.dockerDisk.available" class="reason">{{ vo.dockerDisk.reason || 'Docker 磁盘占用读不到' }}</p>
            </template>
            <p v-else class="reason">不可用 · {{ vo.containers.reason || '无法连接 Docker' }}</p>
          </section>
        </div>

        <section v-if="vo" class="panel disk-panel">
          <div class="panel-head">
            <span class="panel-title">硬盘</span>
            <span v-if="vo.diskIo.readBytesPerSec != null && vo.diskIo.writeBytesPerSec != null" class="io-rate">
              读 {{ formatSize(vo.diskIo.readBytesPerSec) }}/s · 写 {{ formatSize(vo.diskIo.writeBytesPerSec) }}/s
            </span>
          </div>
          <p v-if="vo.disks.length === 0" class="reason">没有读到磁盘占用</p>
          <div v-else class="disk-scroll">
            <table class="disk-table">
              <thead>
                <tr>
                  <th>挂载</th>
                  <th>剩余</th>
                  <th class="bar-col"><span class="sr-only">已用比例</span></th>
                  <th>共</th>
                  <th>inode</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="disk in vo.disks" :key="disk.mount">
                  <th scope="row">
                    <span class="disk-name">{{ disk.label }}</span>
                    <span class="disk-path" :title="diskPlace(disk)">{{ diskPlace(disk) }}</span>
                  </th>
                  <td class="disk-pct" :class="levelClass(disk.usagePercent)">{{ formatSize(disk.availableBytes) }}</td>
                  <td class="bar-col">
                    <el-progress
                      class="disk-bar"
                      :percentage="clampPercent(disk.usagePercent)"
                      :color="usageColor"
                      :stroke-width="6"
                      :show-text="false"
                    />
                  </td>
                  <td class="disk-cap">{{ formatSize(disk.totalBytes) }}<span class="extra">已用 {{ formatSize(disk.usedBytes) }}</span></td>
                  <td class="disk-inode" :class="levelClass(disk.inodeUsagePercent)">
                    <template v-if="disk.inodeUsagePercent != null">
                      {{ formatPercent(disk.inodeUsagePercent) }}
                      <template v-if="disk.inodeUsed != null && disk.inodeTotal != null"> · {{ formatCount(disk.inodeUsed) }}</template>
                    </template>
                    <template v-else>—</template>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { InfoFilled, Refresh } from '@element-plus/icons-vue'
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

const samplingHint = '不含远程数据库，数字只代表后端所在的这台机器。硬盘同一挂载点只计一次。容器只计本机 mao 运行时，未在册是进程重启后留下的残留。自动刷新只作用于硬盘、容器和进程，默认关闭，离开页面不记住。'

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
  align-items: flex-start;
  gap: 16px;
}

.title-line {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px 12px;
}

.title {
  font-size: 16px;
  font-weight: 600;
  color: var(--mao-ink);
}

.host-meta,
.title-note,
.updated,
.auto-refresh-label,
.io-rate,
.reason {
  font-size: 12px;
  color: var(--mao-muted);
  line-height: 1.5;
}

.title-note {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
}

.hint-info {
  color: var(--mao-muted);
  cursor: help;
}

.header-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px 12px;
  min-width: 0;
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

.chart-grid,
.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.detail-grid {
  margin-top: 12px;
}

.panel {
  min-width: 0;
  padding: 12px 14px 8px;
  border: 1px solid var(--mao-border);
  border-radius: 8px;
  background: var(--mao-surface);
}

.disk-panel {
  margin-top: 12px;
  padding-bottom: 4px;
}

.chart-head,
.panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}

.panel-head {
  align-items: center;
  margin-bottom: 8px;
}

.panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--mao-ink);
}

.kpi {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-shrink: 0;
}

.kpi-label {
  font-size: 13px;
  color: var(--mao-muted);
}

.kpi-value {
  font-size: 26px;
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--mao-ink);
}

.facts,
.stat-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin: 0;
}

.facts {
  flex: 1;
  min-width: 0;
  justify-content: flex-end;
}

.facts > div,
.stat-strip > div {
  min-width: 0;
}

.facts dt,
.stat-strip dt {
  font-size: 12px;
  font-weight: 400;
  color: var(--mao-muted);
}

.facts dd,
.stat-strip dd {
  margin: 1px 0 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
  font-variant-numeric: tabular-nums;
  color: var(--mao-ink);
}

.stat-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(108px, 1fr));
  gap: 10px 12px;
}

.stat-strip dd {
  font-size: 15px;
}

.extra {
  display: block;
  max-width: 11em;
  margin-top: 1px;
  font-size: 12px;
  font-weight: 400;
  color: var(--mao-muted);
}

.reason {
  margin: 4px 0 8px;
}

.kpi-value.is-warm,
.facts dd.is-warm,
.stat-strip dd.is-warm,
.disk-pct.is-warm,
.disk-inode.is-warm {
  color: var(--el-color-warning);
}

.kpi-value.is-hot,
.facts dd.is-hot,
.stat-strip dd.is-hot,
.disk-pct.is-hot,
.disk-inode.is-hot {
  color: var(--el-color-danger);
}

.disk-scroll {
  overflow-x: auto;
}

.disk-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.disk-table th,
.disk-table td {
  padding: 7px 10px 7px 0;
  text-align: left;
  vertical-align: middle;
  border-top: 1px solid var(--mao-border);
  font-weight: 400;
}

.disk-table thead th {
  border-top: none;
  padding-top: 0;
  font-size: 12px;
  font-weight: 400;
  color: var(--mao-muted);
}

.disk-table tbody th {
  font-weight: 600;
  color: var(--mao-ink);
}

.disk-name,
.disk-path {
  display: block;
}

.disk-path,
.disk-cap,
.disk-inode {
  color: var(--mao-muted);
}

.disk-path {
  max-width: 280px;
  overflow: hidden;
  font-size: 12px;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.disk-pct {
  font-weight: 600;
  color: var(--mao-ink);
  white-space: nowrap;
}

.bar-col {
  width: 28%;
  min-width: 96px;
}

.disk-bar {
  width: 100%;
}

.disk-bar :deep(.el-progress-bar__outer) {
  background: var(--mao-canvas);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 760px) {
  .card-header,
  .chart-head {
    flex-direction: column;
    align-items: stretch;
  }

  .facts {
    justify-content: flex-start;
  }

  .chart-grid,
  .detail-grid {
    grid-template-columns: 1fr;
  }
}
</style>
