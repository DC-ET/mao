<template>
  <div class="memory-page">
    <div class="page-header">
      <h1 class="page-title">长期记忆</h1>
      <p class="page-desc">
        Agent 在后续会话中会自动参考这些跨会话信息。项目级记忆仅在对应项目的会话中生效，用户级记忆跨项目生效。
      </p>
    </div>

    <div class="memory-toolbar">
      <div class="toolbar-left">
        <el-switch v-model="autoCapture" :disabled="switchSaving" @change="handleSwitchChange" />
        <span class="switch-label">任务完成后自动收集记忆</span>
      </div>
      <button class="create-btn" @click="openCreateDialog">
        <el-icon><Plus /></el-icon>
        新增记忆
      </button>
    </div>

    <div class="memory-filters">
      <div class="scope-tabs">
        <button
          v-for="tab in scopeTabs"
          :key="tab.value"
          class="scope-tab"
          :class="{ active: scopeFilter === tab.value }"
          @click="changeScope(tab.value)"
        >
          {{ tab.label }}
        </button>
      </div>
      <el-select v-model="statusFilter" class="status-select" @change="reload">
        <el-option label="生效中" value="ACTIVE" />
        <el-option label="已忽略" value="DISMISSED" />
        <el-option label="全部" value="" />
      </el-select>
    </div>

    <div v-if="loading" class="empty-state">加载中...</div>
    <div v-else-if="items.length === 0" class="empty-state">
      暂无记忆，可通过任务对话自动沉淀，或点击上方按钮手动添加
    </div>
    <div v-else class="memory-list">
      <div v-for="item in items" :key="item.id" class="memory-card" :class="{ dismissed: item.status === 'DISMISSED' }">
        <div class="memory-content">{{ item.content }}</div>
        <div class="memory-meta">
          <span class="meta-badge scope-badge" :class="item.scope === 'PROJECT' ? 'scope-project' : 'scope-user'">
            {{ item.scope === 'PROJECT' ? `项目:${item.projectKey}` : '用户' }}
          </span>
          <span class="meta-badge source-badge">{{ item.source === 'AUTO' ? '自动' : '手动' }}</span>
          <span class="memory-time">更新于 {{ formatTime(item.updatedAt) }}</span>
          <div class="memory-actions">
            <template v-if="deletingId === item.id">
              <button class="action-text action-text-danger" @click="confirmDelete(item)">确认删除</button>
              <button class="action-text" @click="deletingId = null">取消</button>
            </template>
            <template v-else>
              <button class="action-text" @click="openEditDialog(item)">编辑</button>
              <button v-if="item.status === 'ACTIVE'" class="action-text" @click="toggleStatus(item)">
                忽略
              </button>
              <button v-else class="action-text" @click="toggleStatus(item)">恢复</button>
              <button class="action-text action-text-danger" @click="deletingId = item.id">删除</button>
            </template>
          </div>
        </div>
      </div>
    </div>

    <el-pagination
      v-if="total > pageSize"
      v-model:current-page="page"
      class="memory-pagination"
      layout="prev, pager, next"
      :total="total"
      :page-size="pageSize"
      @current-change="fetchList"
    />

    <el-dialog
      v-model="dialogVisible"
      :title="isEditing ? '编辑记忆' : '新增记忆'"
      width="480px"
      class="memory-dialog"
      append-to-body
      @closed="resetForm"
    >
      <el-form label-position="top">
        <el-form-item v-if="!isEditing" label="作用范围">
          <el-radio-group v-model="form.scope">
            <el-radio value="USER">用户级（跨项目生效）</el-radio>
            <el-radio value="PROJECT">项目级</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="!isEditing && form.scope === 'PROJECT'" label="项目">
          <el-select
            v-model="form.projectKey"
            filterable
            placeholder="选择历史会话中出现过的项目"
            class="project-select"
          >
            <el-option v-for="key in projects" :key="key" :label="key" :value="key" />
          </el-select>
          <div v-if="projects.length === 0" class="project-empty">暂无历史项目，可先在会话中使用项目后添加</div>
        </el-form-item>
        <el-form-item label="内容">
          <el-input
            v-model="form.content"
            type="textarea"
            :rows="4"
            maxlength="500"
            show-word-limit
            placeholder="例如：输出报告用中文；该仓库测试用 Vitest"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <button class="dialog-btn dialog-btn-cancel" @click="dialogVisible = false">取消</button>
        <button class="dialog-btn dialog-btn-confirm" :disabled="!canSubmit || submitting" @click="handleSubmit">
          {{ submitting ? '保存中…' : (isEditing ? '保存' : '创建') }}
        </button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import {
  listMemories,
  createMemory,
  updateMemory,
  deleteMemory,
  getMemorySettings,
  saveMemorySettings,
  listMemoryProjects,
  type MemoryItem,
  type MemoryScope,
  type MemoryStatus
} from '../../api'

const MEMORY_CONTENT_MAX = 500

const loading = ref(false)
const items = ref<MemoryItem[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)

const autoCapture = ref(false)
const switchSaving = ref(false)

const scopeFilter = ref<MemoryScope | ''>('')
const statusFilter = ref<MemoryStatus | ''>('ACTIVE')

const scopeTabs: Array<{ value: MemoryScope | ''; label: string }> = [
  { value: '', label: '全部' },
  { value: 'USER', label: '用户' },
  { value: 'PROJECT', label: '项目' }
]

const dialogVisible = ref(false)
const isEditing = ref(false)
const editingId = ref<number | null>(null)
const deletingId = ref<number | null>(null)
const submitting = ref(false)
const projects = ref<string[]>([])
const form = ref<{ scope: MemoryScope; projectKey: string; content: string }>({
  scope: 'USER',
  projectKey: '',
  content: ''
})

const contentLength = computed(() => Array.from(form.value.content.trim()).length)
const canSubmit = computed(() => {
  if (contentLength.value === 0 || contentLength.value > MEMORY_CONTENT_MAX) return false
  if (!isEditing.value && form.value.scope === 'PROJECT' && !form.value.projectKey) return false
  return true
})

function formatTime(value?: string | null) {
  if (!value) return '-'
  return String(value).replace('T', ' ').slice(0, 16)
}

async function fetchList() {
  loading.value = true
  try {
    const result = await listMemories({
      page: page.value,
      pageSize: pageSize.value,
      scope: scopeFilter.value === '' ? null : scopeFilter.value,
      status: statusFilter.value === '' ? null : statusFilter.value
    })
    items.value = result.records ?? []
    total.value = result.total ?? 0
  } catch {
    // 错误提示由拦截器统一处理
  } finally {
    loading.value = false
  }
}

function reload() {
  page.value = 1
  void fetchList()
}

function changeScope(value: MemoryScope | '') {
  scopeFilter.value = value
  reload()
}

async function loadSettings() {
  try {
    const settings = await getMemorySettings()
    autoCapture.value = settings.autoCaptureEnabled
  } catch {
    // 保持默认关闭：读取失败时开关维持默认关闭态
  }
}

async function handleSwitchChange() {
  if (switchSaving.value) return
  switchSaving.value = true
  const target = autoCapture.value
  try {
    await saveMemorySettings(target)
    ElMessage.success(target ? '已开启自动收集' : '已关闭自动收集')
  } catch {
    autoCapture.value = !target
  } finally {
    switchSaving.value = false
  }
}

async function loadProjects() {
  try {
    projects.value = await listMemoryProjects()
  } catch {
    projects.value = []
  }
}

function openCreateDialog() {
  isEditing.value = false
  editingId.value = null
  form.value = { scope: 'USER', projectKey: '', content: '' }
  if (projects.value.length === 0) void loadProjects()
  dialogVisible.value = true
}

function openEditDialog(item: MemoryItem) {
  isEditing.value = true
  editingId.value = item.id
  form.value = { scope: item.scope, projectKey: item.projectKey ?? '', content: item.content }
  dialogVisible.value = true
}

function resetForm() {
  isEditing.value = false
  editingId.value = null
  form.value = { scope: 'USER', projectKey: '', content: '' }
}

async function handleSubmit() {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  try {
    if (isEditing.value && editingId.value != null) {
      await updateMemory(editingId.value, { content: form.value.content.trim() })
      ElMessage.success('记忆已更新')
    } else {
      await createMemory({
        scope: form.value.scope,
        content: form.value.content.trim(),
        projectKey: form.value.scope === 'PROJECT' ? form.value.projectKey : null
      })
      ElMessage.success('记忆已创建')
    }
    dialogVisible.value = false
    await fetchList()
  } catch {
    // 错误提示由拦截器统一处理
  } finally {
    submitting.value = false
  }
}

async function toggleStatus(item: MemoryItem) {
  const target: MemoryStatus = item.status === 'ACTIVE' ? 'DISMISSED' : 'ACTIVE'
  try {
    await updateMemory(item.id, { status: target })
    ElMessage.success(target === 'DISMISSED' ? '已忽略，不再注入' : '已恢复')
    await fetchList()
  } catch {
    // 错误提示由拦截器统一处理
  }
}

async function confirmDelete(item: MemoryItem) {
  try {
    await deleteMemory(item.id)
    ElMessage.success('已删除')
    deletingId.value = null
    if (items.value.length === 1 && page.value > 1) {
      page.value -= 1
    }
    await fetchList()
  } catch {
    // 错误提示由拦截器统一处理
  }
}

onMounted(() => {
  void loadSettings()
  void fetchList()
})
</script>

<style scoped>
.memory-page {
  max-width: 760px;
}

.page-header {
  margin-bottom: 20px;
}

.page-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--aw-ink);
  margin: 0 0 8px;
}

.page-desc {
  font-size: 13px;
  color: var(--aw-ink-muted);
  margin: 0;
  line-height: 1.5;
  max-width: 560px;
}

.memory-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.switch-label {
  font-size: 13px;
  color: var(--aw-ink);
}

.create-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px;
  border: none;
  border-radius: var(--aw-radius-xs);
  background: var(--aw-primary);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

.create-btn:hover {
  opacity: 0.85;
}

.memory-filters {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.scope-tabs {
  display: flex;
  gap: 4px;
}

.scope-tab {
  padding: 4px 12px;
  border: none;
  border-radius: var(--aw-radius-xs);
  background: transparent;
  color: var(--aw-ink-muted);
  font-size: 13px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}

.scope-tab:hover {
  color: var(--aw-ink);
  background: var(--aw-surface-hover);
}

.scope-tab.active {
  color: var(--aw-primary);
  background: var(--aw-accent-bg);
  font-weight: 500;
}

.status-select {
  width: 110px;
}

.empty-state {
  text-align: center;
  padding: 48px 16px;
  color: var(--aw-ink-muted);
  font-size: 13px;
}

.memory-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.memory-card {
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider-soft);
  border-radius: 8px;
  padding: 12px 14px;
}

.memory-card.dismissed {
  opacity: 0.6;
}

.memory-content {
  font-size: 14px;
  color: var(--aw-ink);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.memory-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  flex-wrap: wrap;
}

.meta-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.6;
}

.scope-badge.scope-user {
  background: var(--aw-accent-bg);
  color: var(--aw-primary);
}

.scope-badge.scope-project {
  background: rgba(31, 124, 226, 0.12);
  color: #1f7ce2;
}

.source-badge {
  background: var(--aw-surface-hover);
  color: var(--aw-ink-muted);
}

.memory-time {
  font-size: 11px;
  color: var(--aw-ink-muted);
}

.memory-actions {
  margin-left: auto;
  display: flex;
  gap: 10px;
}

.action-text {
  border: none;
  background: transparent;
  padding: 0;
  font-size: 12px;
  color: var(--aw-ink-muted);
  cursor: pointer;
}

.action-text:hover {
  color: var(--aw-ink);
}

.action-text-danger:hover {
  color: var(--aw-danger);
}

.memory-pagination {
  margin-top: 16px;
  justify-content: center;
}

.project-select {
  width: 100%;
}

.project-empty {
  font-size: 12px;
  color: var(--aw-ink-muted);
  margin-top: 4px;
}

.dialog-btn {
  padding: 6px 16px;
  border: none;
  border-radius: var(--aw-radius-xs);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

.dialog-btn-cancel {
  background: transparent;
  color: var(--aw-ink-muted);
  border: 1px solid var(--aw-hairline);
}

.dialog-btn-confirm {
  background: var(--aw-primary);
  color: #fff;
  margin-left: 8px;
}

.dialog-btn-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 640px) {
  .memory-toolbar {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }

  .create-btn {
    align-self: flex-end;
  }

  .memory-filters {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }

  .memory-actions {
    margin-left: 0;
  }
}
</style>

<style>
.memory-dialog {
  --el-font-size-base: 13px;
  --el-font-size-small: 12px;
}

.memory-dialog .el-dialog__title {
  font-size: 15px;
  font-weight: 600;
}

.memory-dialog .el-form-item__label {
  font-size: 12px;
  color: var(--aw-ink-muted);
  margin-bottom: 4px !important;
}
</style>
