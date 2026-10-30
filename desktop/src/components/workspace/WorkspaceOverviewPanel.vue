<template>
  <div class="workspace-overview-panel">
    <div class="overview-toolbar">
      <span class="overview-hint">机器人通道工作区不在本人目录内，不在本页签范围</span>
      <div class="overview-toolbar-actions">
        <el-button size="small" :loading="refreshing" @click="refreshAll">
          <el-icon v-if="!refreshing" :size="13"><Refresh /></el-icon>
          刷新
        </el-button>
      </div>
    </div>

    <el-table
      v-loading="loading"
      :data="sortedEntries"
      size="small"
      :default-sort="{ prop: 'lastUsedAt', order: 'descending' }"
      @sort-change="onSortChange"
    >
      <template #empty>
        <el-empty :description="emptyHint" :image-size="60" />
      </template>
      <el-table-column prop="name" label="名称" min-width="200" sortable="custom" show-overflow-tooltip>
        <template #default="{ row }">
          <span class="ws-name">{{ row.name }}</span>
          <el-tag v-if="row.isGit" size="small" type="info" class="ws-git-tag">Git</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="kind" label="类别" width="110">
        <template #default="{ row }">
          <el-tag size="small" :type="kindTag(row.kind)">{{ KIND_LABELS[row.kind as WorkspaceKind] ?? row.kind }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="sizeBytes" label="大小" width="140" sortable="custom">
        <template #default="{ row }">
          <span v-if="row.sizeState === 'ready'" class="ws-size">{{ formatSize(row.sizeBytes ?? undefined) }}</span>
          <span v-else-if="row.sizeState === 'pending'" class="ws-size ws-size-pending">统计中…</span>
          <span v-else class="ws-size ws-size-failed">{{ row.sizeState === 'timeout' ? '统计超时' : '统计失败' }}</span>
          <button
            v-if="row.sizeState === 'timeout' || row.sizeState === 'failed'"
            class="ws-size-retry"
            title="重新统计"
            @click="refreshOne(row)"
          ><el-icon :size="12"><Refresh /></el-icon></button>
        </template>
      </el-table-column>
      <el-table-column label="关联会话" width="150">
        <template #default="{ row }">
          <span class="ws-sessions">
            <span :class="{ 'ws-active': row.activeSessions > 0 }">进行中 {{ row.activeSessions }}</span>
            <span class="ws-sep">·</span>
            <span>归档 {{ row.archivedSessions }}</span>
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="lastUsedAt" label="最近使用" width="170" sortable="custom">
        <template #default="{ row }">{{ formatDateTime(row.lastUsedAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="170" fixed="right">
        <template #default="{ row }">
          <el-button type="primary" link size="small" @click="emit('use-for-new-task', row)">用于新任务</el-button>
          <el-button type="danger" link size="small" @click="openDelete(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 删除确认：目录名 + 大小 + 会话计数 + 活跃引用清单 + 输入目录名（技术方案 §4.3-1） -->
    <el-dialog
      v-model="deleteState.visible"
      title="删除工作区目录"
      width="480px"
      :close-on-click-modal="false"
      append-to-body
    >
      <div v-if="deleteState.entry" class="ws-delete-body">
        <p class="ws-delete-warning">
          将物理删除目录 <b>{{ deleteState.entry.name }}</b>{{ deleteState.entry.sizeState === 'ready' ? `（${formatSize(deleteState.entry.sizeBytes ?? undefined)}）` : '' }}
          及其全部内容，<b>不做回收站、不可恢复</b>。
        </p>
        <p class="ws-delete-warning">
          该目录关联 {{ deleteState.entry.activeSessions }} 个进行中、{{ deleteState.entry.archivedSessions }} 个归档会话；
          删除后这些会话的<b>文件浏览与 Git 面板将不再可用</b>。
        </p>
        <el-alert
          v-if="deleteState.references.length > 0"
          type="warning"
          :closable="false"
          title="存在进行中的会话引用，暂不能删除"
        >
          <div v-for="ref in deleteState.references" :key="ref.id" class="ws-ref-row">
            #{{ ref.id }} {{ ref.title || '未命名会话' }}（{{ ref.phase }}）
          </div>
        </el-alert>
        <el-input
          v-model="deleteState.confirmText"
          :placeholder="`输入目录名 ${deleteState.entry.name} 以确认`"
          class="ws-delete-input"
        />
      </div>
      <template #footer>
        <el-button @click="deleteState.visible = false">取消</el-button>
        <el-button
          type="danger"
          :disabled="!canConfirmDelete"
          :loading="deleteState.submitting"
          @click="confirmDelete"
        >删除</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import {
  deleteWorkspaceByPath,
  fetchWorkspaceOverview,
  fetchWorkspaceReferences,
  refreshWorkspaceOverview,
} from '../../api'
import { formatDateTime } from '../../utils/datetime'
import { formatSize } from '../../utils/file-manager'
import type { WorkspaceKind, WorkspaceOverviewEntry } from '../../types/workspace-overview'

const emit = defineEmits<{
  /** 「用于新任务」：TaskView 负责按条目类别预填新建任务的工作区 */
  'use-for-new-task': [entry: WorkspaceOverviewEntry]
}>()

const KIND_LABELS: Record<WorkspaceKind, string> = {
  temp: '临时工作区',
  project: '项目',
  other: '其他',
}

const entries = ref<WorkspaceOverviewEntry[]>([])
const overviewError = ref<string | null>(null)
const loading = ref(false)
const refreshing = ref(false)
const sortKey = ref<'lastUsedAt' | 'sizeBytes' | 'name'>('lastUsedAt')
const sortOrder = ref<'ascending' | 'descending'>('descending')
let requeryTimer: ReturnType<typeof setTimeout> | null = null
/** pending 重查代际：load / refresh / delete 写入新数据时 +1，作废在途的过期重查响应 */
let requeryGeneration = 0
/** load 自身代际：KeepAlive 下 onMounted + onActivated 会叠加触发并发 load，旧响应后到即丢弃 */
let loadGeneration = 0
/** 删除弹层引用清单代际：弹层重开即 +1，丢弃属于上一个目录的在途响应 */
let referencesGeneration = 0

const deleteState = reactive({
  visible: false,
  entry: null as WorkspaceOverviewEntry | null,
  references: [] as Array<{ id: number; title: string | null; phase: string | null }>,
  confirmText: '',
  submitting: false,
})

const canConfirmDelete = computed(() => {
  const entry = deleteState.entry
  if (!entry) return false
  return deleteState.confirmText === entry.name && deleteState.references.length === 0
})

const sortedEntries = computed(() => {
  const list = [...entries.value]
  const dir = sortOrder.value === 'ascending' ? 1 : -1
  list.sort((a, b) => {
    if (sortKey.value === 'name') return a.name.localeCompare(b.name) * dir
    if (sortKey.value === 'sizeBytes') {
      // 未就绪的大小排最后（与方向无关）
      if (a.sizeBytes == null && b.sizeBytes == null) return 0
      if (a.sizeBytes == null) return 1
      if (b.sizeBytes == null) return -1
      return (a.sizeBytes - b.sizeBytes) * dir
    }
    return (a.lastUsedAt ?? '').localeCompare(b.lastUsedAt ?? '') * dir
  })
  return list
})

const emptyHint = computed(() => overviewError.value || '本人工作区根目录下暂无目录')

function kindTag(kind: WorkspaceKind): 'primary' | 'success' | 'info' | 'warning' {
  if (kind === 'project') return 'primary'
  if (kind === 'temp') return 'info'
  return 'warning'
}

function onSortChange({ prop, order }: { prop: string; order: 'ascending' | 'descending' | null }) {
  if (order == null) return
  if (prop === 'name' || prop === 'sizeBytes' || prop === 'lastUsedAt') {
    sortKey.value = prop
    sortOrder.value = order
  }
}

async function load() {
  const generation = ++loadGeneration
  // 作废在途的 pending 重查：其响应是旧数据，落地会把本次结果覆盖回旧值
  invalidatePendingRequery()
  loading.value = true
  try {
    const result = await fetchWorkspaceOverview()
    // KeepAlive 下 onMounted 与 onActivated 会叠加触发多次并发 load（切页签再触发一次）：
    // 先发的 load 后返回时，其旧快照不得覆盖更新的列表（已删目录会复活）
    if (generation !== loadGeneration) return
    entries.value = result.entries ?? []
    overviewError.value = result.error ?? null
    schedulePendingRequery()
  } catch {
    // 拦截器已提示；总览保持旧数据
  } finally {
    // 只有最新一代负责收 loading：旧响应回来时新一轮可能仍在途
    if (generation === loadGeneration) loading.value = false
  }
}

/** 取消未触发的重查计时器并作废在途请求（代际 +1）。 */
function invalidatePendingRequery() {
  if (requeryTimer) {
    clearTimeout(requeryTimer)
    requeryTimer = null
  }
  requeryGeneration++
}

/** 首屏未就绪的大小：3 秒后重查一次（D3），仍未就绪交给行内刷新 */
function schedulePendingRequery() {
  invalidatePendingRequery()
  if (!entries.value.some(e => e.sizeState === 'pending')) return
  const generation = requeryGeneration
  requeryTimer = setTimeout(async () => {
    requeryTimer = null
    if (generation !== requeryGeneration) return
    try {
      const result = await fetchWorkspaceOverview()
      // await 之后落地前再校验：期间用户可能已刷新 / 删除，旧响应必须丢弃
      if (generation !== requeryGeneration) return
      entries.value = result.entries ?? []
    } catch { /* 静默：保留当前行 */ }
  }, 3000)
}

async function refreshAll() {
  refreshing.value = true
  try {
    await refreshWorkspaceOverview()
    await load()
  } finally {
    refreshing.value = false
  }
}

async function refreshOne(row: WorkspaceOverviewEntry) {
  try {
    await refreshWorkspaceOverview(row.path)
    // 作废在途 load：其旧快照会覆盖下面刚置的 pending，且它自己的
    // schedulePendingRequery 会取消这里刚排的重查计时器——服务端已重算成功，
    // 新大小却永不显示（审查 BUG-6）
    loadGeneration++
    row.sizeState = 'pending'
    row.sizeBytes = null
    schedulePendingRequery()
  } catch { /* 拦截器已提示 */ }
}

function openDelete(entry: WorkspaceOverviewEntry) {
  deleteState.entry = entry
  deleteState.references = []
  deleteState.confirmText = ''
  deleteState.visible = true
  void loadReferences(entry)
}

async function loadReferences(entry: WorkspaceOverviewEntry) {
  const generation = ++referencesGeneration
  const references = await fetchWorkspaceReferences(entry.path)
  // 弹层已重开（换了目录）或已关闭：丢弃属于旧弹层的在途响应
  if (generation !== referencesGeneration) return
  deleteState.references = references
}

async function confirmDelete() {
  const entry = deleteState.entry
  if (!entry || !canConfirmDelete.value || deleteState.submitting) return
  deleteState.submitting = true
  try {
    await deleteWorkspaceByPath(entry.path)
    deleteState.visible = false
    ElMessage.success(`已删除 ${entry.name}`)
    await load()
  } catch {
    // 失败原因已由拦截器 toast（409 有进行中引用 / 400 路径问题）；弹层保持打开
  } finally {
    deleteState.submitting = false
  }
}

onMounted(load)
onActivated(load)

onBeforeUnmount(() => {
  invalidatePendingRequery()
})
</script>

<style scoped>
.workspace-overview-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  padding: 12px;
  overflow: auto;
}

.overview-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.overview-hint {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
}

.overview-toolbar-actions {
  display: flex;
  gap: 8px;
}

.ws-name {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink);
}

.ws-git-tag {
  margin-left: 6px;
}

.ws-size {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-fine);
}

.ws-size-pending {
  color: var(--aw-ink-muted-48);
}

.ws-size-failed {
  color: var(--aw-warning);
}

.ws-size-retry {
  display: inline-flex;
  margin-left: 6px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--aw-primary);
  cursor: pointer;
}

.ws-sessions {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-80);
}

.ws-active {
  color: var(--aw-primary);
  font-weight: 500;
}

.ws-sep {
  margin: 0 4px;
  color: var(--aw-ink-muted-48);
}

.ws-delete-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ws-delete-warning {
  margin: 0;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-80);
  line-height: 1.6;
}

.ws-ref-row {
  font-size: var(--aw-text-fine);
}

.ws-delete-input {
  margin-top: 4px;
}
</style>
