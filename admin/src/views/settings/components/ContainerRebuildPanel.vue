<template>
  <section id="setting-group-container-rebuild" class="setting-section">
    <el-card class="group-card" shadow="never">
      <template #header>
        <div class="group-header">
          <span class="group-title">容器管理</span>
          <div class="header-actions">
            <el-checkbox v-model="includeBusy" :disabled="!canManage || rebuilding">包括正在运行任务的容器</el-checkbox>
            <el-button
              type="primary"
              size="small"
              :disabled="!canManage || rebuilding || rows.length === 0"
              :loading="rebuilding"
              @click="rebuildAll"
            >重建全部</el-button>
            <el-button size="small" :loading="loading" @click="fetchRows">刷新</el-button>
          </div>
        </div>
      </template>

      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="重建会「停 → 删 → 重新创建」容器，中断容器内正在执行的 shell / 终端 / 任务；默认跳过有在跑任务的容器。列表除当前后端进程在册的容器外，还包含 Docker 中未在册的 mao 残留容器（后端重启 / 崩溃遗留）：删除后下次使用时自动按最新配置重建。"
        class="config-tip"
      />

      <div :id="CONTAINER_AUTO_UPGRADE_FIELD_ID" class="setting-field switch-row">
        <span class="switch-label">发版后自动重启空闲容器以收敛代码版本（不重建容器、不打断在跑任务）</span>
        <el-switch
          :model-value="autoUpgrade"
          :disabled="!canWriteSettings || savingUpgrade"
          :loading="savingUpgrade"
          @change="saveAutoUpgrade"
        />
      </div>

      <el-progress
        v-if="rebuilding"
        :percentage="progressPercent"
        :status="progressPercent >= 100 ? 'success' : undefined"
        class="progress"
      />
      <div v-if="resultSummary" class="result-summary">{{ resultSummary }}</div>

      <el-table :data="rows" v-loading="loading" size="small" stripe>
        <template #empty><el-empty description="当前没有容器记录" :image-size="48" /></template>
        <el-table-column prop="userId" label="用户 ID" width="90" />
        <el-table-column prop="agentId" label="Agent ID" width="90" />
        <el-table-column prop="containerName" label="容器名" min-width="180" show-overflow-tooltip />
        <el-table-column label="状态" width="150">
          <template #default="{ row }">
            <div class="state-cell">
              <el-tag :type="row.state === 'running' ? 'success' : 'info'" size="small">
                {{ row.state === 'running' ? '运行中' : '已停止' }}
              </el-tag>
              <el-tooltip
                v-if="!row.tracked"
                content="后端进程不在册的 Docker 残留容器（重启 / 崩溃遗留），删除后下次使用时自动按最新配置重建"
                placement="top"
              >
                <el-tag type="warning" size="small">未在册</el-tag>
              </el-tooltip>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="忙碌" width="90">
          <template #default="{ row }">
            <el-tag v-if="row.busy" type="warning" size="small">有任务</el-tag>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="代码版本" width="110">
          <template #default="{ row }">
            <span v-if="row.runtimeBuild" class="mono">{{ row.runtimeBuild }}</span>
            <el-tooltip v-else content="容器 agent 尚未上报版本：旧版容器会在空闲时自动重启收敛" placement="top">
              <span class="muted">待上报</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="后台版本" width="110">
          <template #default="{ row }">
            <span v-if="row.hostRuntimeBuild" class="mono">{{ row.hostRuntimeBuild }}</span>
            <span v-else class="muted">未启用</span>
          </template>
        </el-table-column>
        <el-table-column label="升级" width="90">
          <template #default="{ row }">
            <el-tag v-if="row.pendingUpgrade" type="warning" size="small">待升级</el-tag>
            <el-tag v-else-if="row.runtimeBuild && row.hostRuntimeBuild" type="success" size="small">一致</el-tag>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="启动时间" width="170">
          <template #default="{ row }">
            <span v-if="row.tracked">{{ formatMs(row.startedAtMs) }}</span>
            <span v-else class="muted" :title="row.ageText || undefined">{{ row.ageText || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="最后使用" width="170">
          <template #default="{ row }">{{ row.tracked ? formatMs(row.lastUsedAtMs) : '-' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.tracked"
              type="primary"
              link
              size="small"
              :disabled="!canManage || rebuilding"
              @click="rebuildOne(row)"
            >重建</el-button>
            <el-button
              v-else
              type="danger"
              link
              size="small"
              :disabled="!canManage || rebuilding"
              @click="rebuildOne(row)"
            >删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { ContainerEntrySummary, ContainerRecycleResult } from '@mao/contracts'
import { api } from '../../../api'
import { CONTAINER_AUTO_UPGRADE_FIELD_ID } from '../settingsSearchCatalog'
import { useAuthStore } from '../../../stores/auth'

const authStore = useAuthStore()
const canManage = computed(() => authStore.hasPermission('container:manage'))
const canWriteSettings = computed(() => authStore.hasPermission('settings:write'))

const AUTO_UPGRADE_KEY = 'runtime.container.autoUpgrade'
const autoUpgrade = ref(true)
const savingUpgrade = ref(false)

async function fetchAutoUpgrade() {
  // 开关值来自系统设置（settings:read）；无读权限时不请求（仅展示、不误报错）
  if (!canWriteSettings.value && !authStore.hasPermission('settings:read')) return
  try {
    const { data } = await api.get('/system-settings')
    const row = (Array.isArray(data) ? data : []).find(
      (item: { settingKey?: string }) => item?.settingKey === AUTO_UPGRADE_KEY,
    )
    autoUpgrade.value = String(row?.value ?? 'true').trim().toLowerCase() !== 'false'
  } catch { /* 拦截器已提示失败 */ }
}

async function saveAutoUpgrade(next: string | number | boolean) {
  const value = next === true ? 'true' : 'false'
  savingUpgrade.value = true
  try {
    await api.put(`/system-settings/${AUTO_UPGRADE_KEY}`, { value })
    autoUpgrade.value = value === 'true'
    ElMessage.success(value === 'true' ? '已开启容器自动升级' : '已关闭容器自动升级')
  } catch {
    // 保存失败：回读实际值，避免开关停在错误状态
    void fetchAutoUpgrade()
  } finally {
    savingUpgrade.value = false
  }
}

const rows = ref<ContainerEntrySummary[]>([])
const loading = ref(false)
const includeBusy = ref(false)
const rebuilding = ref(false)
const progressCurrent = ref(0)
const progressTotal = ref(0)
const resultSummary = ref('')
const progressPercent = computed(() =>
  progressTotal.value === 0 ? 0 : Math.min(100, Math.round((progressCurrent.value / progressTotal.value) * 100)),
)

async function fetchRows() {
  if (!canManage.value) return
  loading.value = true
  try {
    const { data } = await api.get('/admin/containers')
    rows.value = Array.isArray(data) ? data : []
  } catch { /* 拦截器已提示失败 */ } finally {
    loading.value = false
  }
}

function formatMs(ms?: number | null): string {
  if (!ms) return '-'
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function callRecycle(userId: number, force: boolean, agentId?: number): Promise<ContainerRecycleResult> {
  const { data } = await api.post(`/users/${userId}/container/recycle`, { force, agentId })
  return (data ?? { userId, agentId: agentId ?? null, status: 'failed' }) as ContainerRecycleResult
}

async function rebuildOne(row: ContainerEntrySummary) {
  const target = `用户 #${row.userId}（Agent #${row.agentId}）`
  try {
    await ElMessageBox.confirm(
      row.tracked
        ? `将重建${target}的容器，会中断容器内正在执行的任务。确定继续？`
        : `将删除${target}的 Docker 残留容器（未在册），下次使用时自动按最新配置重建。确定继续？`,
      row.tracked ? '重建容器' : '删除残留容器',
      { confirmButtonText: row.tracked ? '重建' : '删除', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  try {
    const result = await callRecycle(row.userId, includeBusy.value, row.agentId)
    if (result.status === 'rebuilt') ElMessage.success(`${target}容器已重建`)
    else if (result.status === 'removed') ElMessage.success(`${target}残留容器已删除，下次使用时自动重建`)
    else if (result.status === 'none') ElMessage.info(`${target}当前没有容器`)
    else if (result.status === 'skipped-busy') ElMessage.warning(`${target}有在跑任务，已跳过`)
    else ElMessage.error(`${target}操作失败：${result.error || '未知错误'}`)
    await fetchRows()
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || e?.message || '操作失败')
  }
}

async function rebuildAll() {
  const targets = includeBusy.value ? rows.value : rows.value.filter((row) => !row.busy)
  const skipped = rows.value.length - targets.length
  if (targets.length === 0) {
    ElMessage.info('没有可处理的容器（有任务的容器已跳过，可勾选「包括正在运行任务的容器」）')
    return
  }
  const untrackedCount = targets.filter((row) => !row.tracked).length
  try {
    await ElMessageBox.confirm(
      `将依次处理 ${targets.length} 个容器${untrackedCount > 0 ? `（其中 ${untrackedCount} 个未在册残留容器将被删除）` : ''}${skipped > 0 ? `，跳过 ${skipped} 个有任务的容器` : ''}，过程中会中断容器内正在执行的任务。确定继续？`,
      '重建全部容器',
      { confirmButtonText: '开始处理', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  rebuilding.value = true
  progressCurrent.value = 0
  progressTotal.value = targets.length
  resultSummary.value = ''
  let rebuilt = 0
  let removed = 0
  let none = 0
  let skippedBusy = 0
  let failed = 0
  const failures: string[] = []
  for (const row of targets) {
    try {
      const result = await callRecycle(row.userId, includeBusy.value, row.agentId)
      if (result.status === 'rebuilt') rebuilt += 1
      else if (result.status === 'removed') removed += 1
      else if (result.status === 'none') none += 1
      else if (result.status === 'skipped-busy') skippedBusy += 1
      else {
        failed += 1
        failures.push(`#${row.userId}/#${row.agentId}：${result.error || '未知错误'}`)
      }
    } catch (e: any) {
      failed += 1
      failures.push(`#${row.userId}/#${row.agentId}：${e?.message || '请求失败'}`)
    } finally {
      progressCurrent.value += 1
    }
  }
  rebuilding.value = false
  const parts = [`重建 ${rebuilt}`, `删除 ${removed}`, `无容器 ${none}`, `跳过 ${skippedBusy}`, `失败 ${failed}`]
  resultSummary.value = `全部处理完成：${parts.join(' / ')}${failures.length > 0 ? `；失败明细：${failures.slice(0, 5).join('；')}` : ''}`
  if (failed > 0) ElMessage.warning(resultSummary.value)
  else ElMessage.success('全部处理完成')
  await fetchRows()
}

onMounted(() => {
  void fetchRows()
  void fetchAutoUpgrade()
})
</script>

<style scoped>
.group-header { display: flex; align-items: center; justify-content: space-between; }
.group-title { font-weight: 600; }
.header-actions { display: flex; align-items: center; gap: 12px; }
.config-tip { margin-bottom: 12px; }
.switch-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.switch-label { font-size: 13px; color: var(--el-text-color-regular); }
.progress { margin-bottom: 10px; }
.result-summary { font-size: 13px; color: var(--el-text-color-regular); margin-bottom: 10px; }
.state-cell { display: flex; align-items: center; gap: 4px; }
.mono { font-family: var(--el-font-family-mono, monospace); font-size: 12px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
</style>

