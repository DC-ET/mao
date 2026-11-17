<template>
  <div class="host-status-view">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>主机状态</span>
          <div class="header-actions">
            <span class="card-hint">后端所在机器的当前快照（{{ REFRESH_INTERVAL_MS / 1000 }}s 自动刷新），不含远程数据库。硬盘同一挂载点只计一次；容器只计这台机器上的 mao 运行时，未在册是进程重启后留下的残留</span>
            <span v-if="lastUpdatedText" class="card-hint">更新于 {{ lastUpdatedText }}</span>
            <el-button :loading="loading" aria-label="刷新" title="刷新" @click="fetchVo">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </div>
        </div>
      </template>

      <el-skeleton v-if="vo == null && loading" :rows="6" animated />
      <el-alert v-else-if="vo == null" type="error" :closable="false" show-icon :title="loadError || '主机状态暂时读不到'">
        <el-button size="small" @click="fetchVo">重试</el-button>
      </el-alert>
      <template v-else>
        <div class="host-meta">{{ vo.hostname }} · {{ platformLabel(vo.platform) }} · 开机 {{ formatUptime(vo.uptimeSeconds) }}</div>

        <div class="metric-grid">
          <section class="metric-card">
            <div class="metric-label">CPU</div>
            <div class="metric-value" :class="levelClass(vo.cpu.usagePercent)">
              {{ vo.cpu.usagePercent == null ? '采样中' : formatPercent(vo.cpu.usagePercent) }}
            </div>
            <el-progress
              v-if="vo.cpu.usagePercent != null"
              :percentage="clampPercent(vo.cpu.usagePercent)"
              :color="usageColor"
              :stroke-width="8"
              :show-text="false"
            />
            <div class="metric-sub">{{ vo.cpu.cores }} 核</div>
            <div class="metric-sub">负载 {{ formatLoad(vo.cpu.load1, vo.cpu.load5, vo.cpu.load15) }}</div>
            <div class="metric-note">1 / 5 / 15 分钟</div>
          </section>

          <section class="metric-card">
            <div class="metric-label">内存</div>
            <div class="metric-value" :class="levelClass(vo.memory.usagePercent)">{{ formatPercent(vo.memory.usagePercent) }}</div>
            <el-progress
              :percentage="clampPercent(vo.memory.usagePercent)"
              :color="usageColor"
              :stroke-width="8"
              :show-text="false"
            />
            <div class="metric-sub">已用 {{ formatSize(vo.memory.usedBytes) }} / 共 {{ formatSize(vo.memory.totalBytes) }}</div>
            <div class="metric-sub">可用 {{ formatSize(vo.memory.availableBytes) }} · {{ memoryHint(vo.memorySource) }}</div>
            <div v-if="vo.memory.swapTotalBytes != null && vo.memory.swapUsedBytes != null" class="metric-note">
              交换区 已用 {{ formatSize(vo.memory.swapUsedBytes) }} / 共 {{ formatSize(vo.memory.swapTotalBytes) }}
            </div>
          </section>

          <section class="metric-card">
            <div class="metric-label">容器</div>
            <template v-if="vo.containers.available">
              <div class="metric-value">{{ vo.containers.running }}</div>
              <div class="metric-sub">运行中 · 共 {{ vo.containers.total }}</div>
              <div class="metric-sub">已停止 {{ vo.containers.stopped }} · 未在册 {{ vo.containers.untracked }} · 有任务 {{ vo.containers.busy }}</div>
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

        <div class="disk-section">
          <div class="disk-title">硬盘</div>
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
          </div>
        </div>
      </template>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Refresh } from '@element-plus/icons-vue'
import type { HostStatusVo } from '@mao/contracts'
import { api } from '../../api'
import { useAuthStore } from '../../stores/auth'
import { formatDateTime } from '../../utils/datetime'
import { formatSize } from '../session/utils/file-format'
import {
  clampPercent,
  diskPlace,
  formatLoad,
  formatPercent,
  formatUptime,
  memoryHint,
  platformLabel,
  usageColor,
  usageLevel
} from './hostFormat'

const REFRESH_INTERVAL_MS = 15_000

const router = useRouter()
const auth = useAuthStore()
const canOpenSettings = computed(() => auth.hasPermission('settings:read'))

const loading = ref(false)
const loadError = ref('')
const vo = ref<HostStatusVo | null>(null)
const lastUpdated = ref<Date | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

const lastUpdatedText = computed(() => (lastUpdated.value ? formatDateTime(lastUpdated.value.toISOString()) : ''))

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

.host-meta {
  margin-bottom: 16px;
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
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
.disk-percent.is-warm {
  color: var(--el-color-warning);
}

.metric-value.is-hot,
.disk-percent.is-hot {
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
  margin-bottom: 8px;
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

@media (max-width: 900px) {
  .card-header {
    flex-direction: column;
    align-items: stretch;
  }

  .metric-grid {
    grid-template-columns: 1fr;
  }
}
</style>
