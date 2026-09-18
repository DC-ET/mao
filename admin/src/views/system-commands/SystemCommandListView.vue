<template>
  <div class="system-commands">
    <el-card>
      <template #header>
        <div class="card-header">
          <div>
            <div class="card-title">指令管理</div>
            <div class="card-hint">管理全局系统指令，以及各用户的个人快捷指令。</div>
          </div>
          <el-button v-if="activeTab === 'system'" type="primary" @click="openCreate">新增指令</el-button>
        </div>
      </template>

      <el-tabs v-model="activeTab" class="command-tabs" @tab-change="handleTabChange">
        <el-tab-pane label="系统指令" name="system" />
        <el-tab-pane label="个人指令" name="personal" />
      </el-tabs>

      <el-form :inline="true" class="search-form">
        <el-form-item label="关键词">
          <el-input
            v-model="state.keyword"
            clearable
            :placeholder="activeTab === 'personal' ? '名称 / 内容 / 用户' : '名称 / 内容'"
            style="width: 240px"
            @keyup.enter="handleSearch"
            @clear="handleSearch"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">查询</el-button>
          <el-button @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>

      <el-alert
        v-if="activeTab === 'personal'"
        type="info"
        :closable="false"
        show-icon
        title="个人指令由用户在桌面端创建与编辑，此处可查看与删除；如需新建或修改请由对应用户操作。"
        style="margin-bottom: 12px"
      />

      <!-- Desktop: system table -->
      <el-table
        v-if="activeTab === 'system' && !isMobile"
        :data="pagedRows"
        v-loading="loading"
        stripe
      >
        <template #empty>
          <el-empty description="暂无系统指令" :image-size="60" />
        </template>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="指令名称" width="160" show-overflow-tooltip />
        <el-table-column label="指令内容" min-width="280">
          <template #default="{ row }">
            <el-tooltip :content="row.content" placement="top" :show-after="200">
              <div class="content-clamp">{{ row.content }}</div>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="170" class-name="hide-on-mobile" label-class-name="hide-on-mobile">
          <template #default="{ row }">{{ formatDateTimeColumn(row, null, row.updatedAt || row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="openDetail(row)">查看</el-button>
            <el-button type="primary" link size="small" @click="openEdit(row)">编辑</el-button>
            <el-popconfirm
              :title="`确认删除指令「${row.name}」？`"
              confirm-button-text="删除"
              cancel-button-text="取消"
              @confirm="handleDeleteSystem(row)"
            >
              <template #reference>
                <el-button type="danger" link size="small">删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>

      <!-- Desktop: personal table -->
      <el-table
        v-else-if="activeTab === 'personal' && !isMobile"
        :data="pagedRows"
        v-loading="loading"
        stripe
      >
        <template #empty>
          <el-empty description="暂无个人指令" :image-size="60" />
        </template>
        <el-table-column label="用户" width="140">
          <template #default="{ row }">
            <el-tooltip :content="`ID: ${row.userId}`" placement="top">
              <span>{{ userLabel(row) }}</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="指令名称" width="150" show-overflow-tooltip />
        <el-table-column label="指令内容" min-width="240">
          <template #default="{ row }">
            <el-tooltip :content="row.content" placement="top" :show-after="200">
              <div class="content-clamp">{{ row.content }}</div>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="170" class-name="hide-on-mobile" label-class-name="hide-on-mobile">
          <template #default="{ row }">{{ formatDateTimeColumn(row, null, row.updatedAt || row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="openDetail(row)">查看</el-button>
            <el-popconfirm
              :title="`确认删除「${userLabel(row)}」的指令「${row.name}」？`"
              confirm-button-text="删除"
              cancel-button-text="取消"
              @confirm="handleDeletePersonal(row)"
            >
              <template #reference>
                <el-button type="danger" link size="small">删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>

      <!-- Mobile cards -->
      <div v-else class="mobile-card-list" v-loading="loading">
        <el-card v-for="row in pagedRows" :key="`${row.userId ?? 0}-${row.id}`" shadow="hover">
          <div class="mobile-card-head">
            <span class="mobile-card-title">{{ row.name }}</span>
          </div>
          <div v-if="activeTab === 'personal'" class="mobile-card-row">
            <span class="mobile-card-label">用户</span>
            <span>{{ userLabel(row) }}</span>
          </div>
          <div class="mobile-card-content">{{ row.content }}</div>
          <div class="mobile-card-actions">
            <el-button type="primary" link size="small" @click="openDetail(row)">查看</el-button>
            <template v-if="activeTab === 'system'">
              <el-button type="primary" link size="small" @click="openEdit(row)">编辑</el-button>
              <el-popconfirm
                :title="`确认删除指令「${row.name}」？`"
                confirm-button-text="删除"
                cancel-button-text="取消"
                @confirm="handleDeleteSystem(row)"
              >
                <template #reference>
                  <el-button type="danger" link size="small">删除</el-button>
                </template>
              </el-popconfirm>
            </template>
            <template v-else>
              <el-popconfirm
                :title="`确认删除「${userLabel(row)}」的指令「${row.name}」？`"
                confirm-button-text="删除"
                cancel-button-text="取消"
                @confirm="handleDeletePersonal(row)"
              >
                <template #reference>
                  <el-button type="danger" link size="small">删除</el-button>
                </template>
              </el-popconfirm>
            </template>
          </div>
        </el-card>
        <el-empty v-if="!loading && pagedRows.length === 0" :description="emptyText" />
      </div>

      <ResponsivePagination
        class="pagination"
        v-model:current-page="state.currentPage"
        v-model:page-size="state.pageSize"
        :page-sizes="[10, 20, 50, 100]"
        :total="state.filtered.length"
        @size-change="handleSizeChange"
      />
    </el-card>

    <ResponsiveDialog
      v-if="formVisible"
      v-model="formVisible"
      :title="isEdit ? '编辑指令' : '新增指令'"
      width="560px"
    >
      <el-form ref="formRef" :model="form" :rules="formRules" label-width="90px">
        <el-form-item label="指令名称" prop="name">
          <el-input
            v-model="form.name"
            placeholder="字母、数字、中文、下划线、连字符"
          />
          <div class="form-hint">同一范围内名称需唯一，支持字母、数字、中文、下划线和连字符。</div>
        </el-form-item>
        <el-form-item label="指令内容" prop="content">
          <el-input
            v-model="form.content"
            type="textarea"
            :rows="8"
            placeholder="指令内容（提示词模板）"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
      </template>
    </ResponsiveDialog>

    <ResponsiveDialog
      v-if="detailVisible && detailRow"
      v-model="detailVisible"
      :title="`指令：${detailRow.name || ''}`"
      width="700px"
    >
      <div class="command-detail">
        <p><strong>用户：</strong>{{ activeTab === 'personal' ? userLabel(detailRow) : '系统（全局）' }}</p>
        <p><strong>更新时间：</strong>{{ formatDateTime(detailRow.updatedAt || detailRow.createdAt) }}</p>
        <el-divider />
        <div class="command-body">
          <pre>{{ detailRow.content }}</pre>
        </div>
      </div>
    </ResponsiveDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, reactive, ref } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage } from 'element-plus'
import { api } from '../../api'
import { useBreakpoint } from '../../composables/useBreakpoint'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'
import ResponsivePagination from '../../components/ResponsivePagination.vue'
import { formatDateTime, formatDateTimeColumn } from '../../utils/datetime'

const { isMobile } = useBreakpoint()

type TabType = 'system' | 'personal'

interface CommandRow {
  id?: number
  userId?: number
  name?: string
  content?: string
  username?: string | null
  displayName?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

interface TabState {
  rows: CommandRow[]
  filtered: CommandRow[]
  keyword: string
  currentPage: number
  pageSize: number
}

function createTabState(): TabState {
  return reactive<TabState>({
    rows: [],
    filtered: [],
    keyword: '',
    currentPage: 1,
    pageSize: 10,
  })
}

const activeTab = ref<TabType>('system')
const tabStates: Record<TabType, TabState> = {
  system: createTabState(),
  personal: createTabState(),
}
const state = computed(() => tabStates[activeTab.value])

const loading = ref(false)
const emptyText = computed(() => activeTab.value === 'personal' ? '暂无个人指令' : '暂无系统指令')

const pagedRows = computed(() => {
  const s = state.value
  const start = (s.currentPage - 1) * s.pageSize
  return s.filtered.slice(start, start + s.pageSize)
})

const formVisible = ref(false)
const isEdit = ref(false)
const submitting = ref(false)
const formRef = ref<FormInstance>()
const editingId = ref<number | null>(null)
const detailVisible = ref(false)
const detailRow = ref<CommandRow | null>(null)

const form = reactive({
  name: '',
  content: '',
})

const NAME_PATTERN = /^[a-zA-Z0-9一-龥_-]+$/

const formRules: FormRules = {
  name: [
    { required: true, message: '请输入指令名称', trigger: 'blur' },
    {
      pattern: NAME_PATTERN,
      message: '名称只能包含字母、数字、中文、下划线和连字符',
      trigger: 'blur',
    },
  ],
  content: [{ required: true, message: '请输入指令内容', trigger: 'blur' }],
}

function applyFilter() {
  const s = state.value
  const kw = s.keyword.trim().toLowerCase()
  if (!kw) {
    s.filtered = s.rows
  } else {
    s.filtered = s.rows.filter((row) => {
      const userPart = `${row.username || ''} ${row.displayName || ''} ${row.userId ?? ''}`
      return `${row.name || ''} ${row.content || ''} ${userPart}`.toLowerCase().includes(kw)
    })
  }
  const maxPage = Math.max(1, Math.ceil(s.filtered.length / s.pageSize))
  if (s.currentPage > maxPage) s.currentPage = maxPage
}

let fetchSeq = 0
async function loadActiveTab() {
  const seq = ++fetchSeq
  const tab = activeTab.value
  loading.value = true
  try {
    const url = tab === 'personal' ? '/admin/user-commands' : '/admin/system-commands'
    const { data } = await api.get(url)
    if (seq !== fetchSeq) return
    const s = tabStates[tab]
    s.rows = data || []
    applyFilter()
  } catch {
    // interceptor handles toast
  } finally {
    if (seq === fetchSeq) loading.value = false
  }
}

function handleTabChange(tab: string | number) {
  void (tab === 'personal' ? loadPersonal() : loadSystem())
}

function loadSystem() {
  if (activeTab.value !== 'system') activeTab.value = 'system'
  return loadActiveTab()
}

function loadPersonal() {
  if (activeTab.value !== 'personal') activeTab.value = 'personal'
  return loadActiveTab()
}

function handleSearch() {
  state.value.currentPage = 1
  applyFilter()
}

function handleReset() {
  state.value.keyword = ''
  state.value.currentPage = 1
  applyFilter()
}

function handleSizeChange() {
  state.value.currentPage = 1
}

function userLabel(row: CommandRow) {
  return row.displayName || row.username || `用户#${row.userId}`
}

function openDetail(row: CommandRow) {
  detailRow.value = row
  detailVisible.value = true
}

function openCreate() {
  isEdit.value = false
  editingId.value = null
  form.name = ''
  form.content = ''
  formVisible.value = true
}

function openEdit(row: CommandRow) {
  isEdit.value = true
  editingId.value = row.id ?? null
  form.name = row.name || ''
  form.content = row.content || ''
  formVisible.value = true
}

async function handleSubmit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  const payload = {
    name: form.name.trim(),
    content: form.content,
  }

  submitting.value = true
  try {
    if (isEdit.value && editingId.value != null) {
      await api.put(`/admin/system-commands/${editingId.value}`, payload)
      ElMessage.success('指令更新成功')
    } else {
      await api.post('/admin/system-commands', payload)
      ElMessage.success('指令创建成功')
    }
    formVisible.value = false
    await loadSystem()
  } catch {
    // interceptor handles toast
  } finally {
    submitting.value = false
  }
}

async function handleDeleteSystem(row: CommandRow) {
  try {
    await api.delete(`/admin/system-commands/${row.id}`)
    ElMessage.success('删除成功')
    await loadSystem()
  } catch {
    // interceptor handles toast
  }
}

async function handleDeletePersonal(row: CommandRow) {
  try {
    await api.delete(`/admin/user-commands/${row.userId}/${row.id}`)
    ElMessage.success('删除成功')
    await loadPersonal()
  } catch {
    // interceptor handles toast
  }
}

onActivated(() => {
  void loadActiveTab()
})
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--mao-ink);
}

.card-hint {
  margin-top: 4px;
  font-size: 13px;
  color: var(--mao-muted);
}

.command-tabs {
  margin-bottom: 4px;
}

.search-form {
  margin-bottom: 12px;
}

.content-clamp {
  font-size: 13px;
  color: var(--mao-ink);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 3.9em;
}

.pagination {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}

.form-hint {
  color: var(--mao-muted);
  font-size: 12px;
  margin-top: 4px;
}

.command-detail p {
  margin: 8px 0;
}

.command-body pre {
  background: var(--el-fill-color-light);
  padding: 16px;
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 500px;
  overflow-y: auto;
  font-size: 13px;
  line-height: 1.6;
  margin: 0;
}

.mobile-card-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mobile-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.mobile-card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--mao-ink);
}

.mobile-card-row {
  display: flex;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 13px;
}

.mobile-card-label {
  color: var(--mao-muted);
  flex-shrink: 0;
}

.mobile-card-content {
  font-size: 13px;
  color: var(--mao-ink);
  white-space: pre-wrap;
  word-break: break-word;
  margin-bottom: 8px;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  line-clamp: 4;
  overflow: hidden;
}

.mobile-card-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
