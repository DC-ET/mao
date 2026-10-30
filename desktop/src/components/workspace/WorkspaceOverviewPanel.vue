<template>
  <div class="workspace-overview-panel">
    <div class="overview-toolbar">
      <span class="overview-hint">临时工作区不在此列表。机器人通道工作区不在本人目录内，也不在此页签</span>
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
      <el-table-column label="操作" width="250" fixed="right">
        <template #default="{ row }">
          <el-button type="primary" link size="small" @click="emit('open-file-manager', row)">文件管理</el-button>
          <el-button type="primary" link size="small" @click="emit('use-for-new-task', row)">新任务</el-button>
          <el-button type="danger" link size="small" @click="openDelete(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 删除确认：目录名 + 会话计数 + 活跃引用清单 + 输入目录名 -->
    <el-dialog
      v-model="deleteState.visible"
      title="删除工作区目录"
      width="480px"
      :close-on-click-modal="false"
      append-to-body
    >
      <div v-if="deleteState.entry" class="ws-delete-body">
        <p class="ws-delete-warning">
          将物理删除目录 <b>{{ deleteState.entry.name }}</b>
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
import { computed, onActivated, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import {
  deleteWorkspaceByPath,
  fetchWorkspaceOverview,
  fetchWorkspaceReferences,
} from '../../api'
import { formatDateTime } from '../../utils/datetime'
import type { WorkspaceKind, WorkspaceOverviewEntry } from '../../types/workspace-overview'

const emit = defineEmits<{
  /** 「新任务」：TaskView 负责按条目类别预填新建任务的工作区 */
  'use-for-new-task': [entry: WorkspaceOverviewEntry]
  /** 「文件管理」：打开该目录自己的文件管理页签 */
  'open-file-manager': [entry: WorkspaceOverviewEntry]
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
const sortKey = ref<'lastUsedAt' | 'name'>('lastUsedAt')
const sortOrder = ref<'ascending' | 'descending'>('descending')
/** load 自身代际：KeepAlive 下 onMounted + onActivated 会叠加触发并发 load，旧响应后到即丢弃 */
let loadGeneration = 0
/** 在途 load 计数：loading 收敛按它算，被更新代际作废的 load 也要收尾（审查 BUG-7a） */
let loadInFlight = 0
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
  const list = entries.value.filter(entry => entry.kind !== 'temp')
  const dir = sortOrder.value === 'ascending' ? 1 : -1
  list.sort((a, b) => {
    if (sortKey.value === 'name') return a.name.localeCompare(b.name) * dir
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
  if (prop === 'name' || prop === 'lastUsedAt') {
    sortKey.value = prop
    sortOrder.value = order
  }
}

async function load() {
  const generation = ++loadGeneration
  loadInFlight++
  loading.value = true
  try {
    const result = await fetchWorkspaceOverview()
    // KeepAlive 下 onMounted 与 onActivated 会叠加触发多次并发 load（切页签再触发一次）：
    // 先发的 load 后返回时，其旧快照不得覆盖更新的列表（已删目录会复活）
    if (generation !== loadGeneration) return
    entries.value = result.entries ?? []
    overviewError.value = result.error ?? null
  } catch {
    // 拦截器已提示；总览保持旧数据
  } finally {
    // loading 收敛按在途计数而非代际：被更新代际作废的 load 也必须收尾，
    // 否则行内刷新 bump 代际后遮罩永不消失、行内按钮全点不动（审查 BUG-7a）
    loadInFlight--
    if (loadInFlight <= 0) loading.value = false
  }
}

async function refreshAll() {
  refreshing.value = true
  try {
    await load()
  } finally {
    refreshing.value = false
  }
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
