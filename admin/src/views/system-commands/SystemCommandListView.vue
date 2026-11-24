<template>
  <div class="system-commands">
    <el-card>
      <template #header>
        <div class="card-header">
          <div>
            <div class="card-title">指令管理</div>
            <div class="card-hint">管理系统指令的内容，以及全局或按角色可见。</div>
          </div>
          <el-button v-if="canWrite && activeTab === 'system'" type="primary" @click="openCreate">新增指令</el-button>
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
        title="个人指令由用户在桌面端创建与编辑。此处可查看、删除，或将其复制为系统指令；默认全局可用，可改为指定角色。原个人指令保留。"
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
        <el-table-column label="可见范围" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">{{ visibilityLabel(row) }}</template>
        </el-table-column>
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
            <template v-if="canWrite">
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
        <el-table-column label="操作" width="250" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="openDetail(row)">查看</el-button>
            <el-button v-if="canWrite" type="primary" link size="small" @click="openPromote(row)">添加到系统指令</el-button>
            <el-popconfirm
              v-if="canWrite"
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
          <div v-else class="mobile-card-row">
            <span class="mobile-card-label">可见范围</span>
            <span>{{ visibilityLabel(row) }}</span>
          </div>
          <div class="mobile-card-content">{{ row.content }}</div>
          <div class="mobile-card-actions">
            <el-button type="primary" link size="small" @click="openDetail(row)">查看</el-button>
            <template v-if="activeTab === 'system' && canWrite">
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
            <template v-else-if="activeTab === 'personal' && canWrite">
              <el-button type="primary" link size="small" @click="openPromote(row)">添加到系统指令</el-button>
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
        :total="paginationTotal"
        @size-change="handleSizeChange"
        @current-change="handlePageChange"
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
        <el-form-item label="可见范围">
          <el-radio-group v-model="form.visibility" @change="(value: string) => { if (value === 'all') form.roleIds = [] }">
            <el-radio value="all">全局可用</el-radio>
            <el-radio value="roles">指定角色</el-radio>
          </el-radio-group>
          <div class="form-hint">指定角色后，不在这些角色里的用户不会在桌面看到这条指令，也无法用 #{名称}# 展开它。</div>
        </el-form-item>
        <el-form-item v-if="form.visibility === 'roles'" label="角色" prop="roleIds">
          <el-select
            v-model="form.roleIds"
            multiple
            filterable
            collapse-tags
            collapse-tags-tooltip
            placeholder="至少选择一个角色"
            style="width: 100%"
          >
            <el-option v-for="role in roleOptions" :key="role.id" :label="role.name" :value="role.id" />
          </el-select>
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
        <p v-if="activeTab === 'personal'"><strong>用户：</strong>{{ userLabel(detailRow) }}</p>
        <p v-else><strong>可见范围：</strong>{{ detailVisibility(detailRow) }}</p>
        <p><strong>更新时间：</strong>{{ formatDateTime(detailRow.updatedAt || detailRow.createdAt) }}</p>
        <el-divider />
        <div class="command-body">
          <pre>{{ detailRow.content }}</pre>
        </div>
      </div>
      <template v-if="activeTab === 'personal' && canWrite" #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button type="primary" @click="openPromoteFromDetail">添加到系统指令</el-button>
      </template>
    </ResponsiveDialog>

    <ResponsiveDialog
      v-if="promoteVisible"
      v-model="promoteVisible"
      title="添加到系统指令"
      width="560px"
    >
      <el-form ref="promoteFormRef" :model="promoteForm" :rules="promoteRules" label-width="90px">
        <el-form-item label="来源用户">
          <span>{{ promoteSource ? userLabel(promoteSource) : '' }}</span>
        </el-form-item>
        <el-form-item label="指令名称" prop="name">
          <el-input
            v-model="promoteForm.name"
            placeholder="字母、数字、中文、下划线、连字符"
          />
          <div class="form-hint">复制为系统指令。默认全局可用，可改为指定角色。原个人指令保留。名称不能与已有系统指令重复。</div>
        </el-form-item>
        <el-form-item label="指令内容" prop="content">
          <el-input
            v-model="promoteForm.content"
            type="textarea"
            :rows="8"
            placeholder="指令内容（提示词模板）"
          />
        </el-form-item>
        <el-form-item label="可见范围">
          <el-radio-group v-model="promoteForm.visibility" @change="(value: string) => { if (value === 'all') promoteForm.roleIds = [] }">
            <el-radio value="all">全局可用</el-radio>
            <el-radio value="roles">指定角色</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="promoteForm.visibility === 'roles'" label="角色" prop="roleIds">
          <el-select
            v-model="promoteForm.roleIds"
            multiple
            filterable
            collapse-tags
            collapse-tags-tooltip
            placeholder="至少选择一个角色"
            style="width: 100%"
          >
            <el-option v-for="role in roleOptions" :key="role.id" :label="role.name" :value="role.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="promoteVisible = false">取消</el-button>
        <el-button type="primary" :loading="promoting" @click="handlePromote">添加</el-button>
      </template>
    </ResponsiveDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, reactive, ref } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage } from 'element-plus'
import { api, apiGetWithHeaders } from '../../api'
import { useBreakpoint } from '../../composables/useBreakpoint'
import { useAuthStore } from '../../stores/auth'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'
import ResponsivePagination from '../../components/ResponsivePagination.vue'
import { formatDateTime, formatDateTimeColumn } from '../../utils/datetime'
import { COMMAND_VISIBILITY_LABELS } from '../../utils/commandVisibilityLabels'
import type { CommandVisibility } from '@mao/contracts'

const { isMobile } = useBreakpoint()
const authStore = useAuthStore()
const canWrite = computed(() => authStore.hasPermission('command:write'))

type TabType = 'system' | 'personal'

interface CommandRow {
  id?: number
  userId?: number
  name?: string
  content?: string
  visibility?: CommandVisibility
  roleIds?: number[]
  roleNames?: string[]
  username?: string | null
  displayName?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

interface RoleOption {
  id: number
  name: string
  code: string
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

/**
 * 个人指令为服务端分页（keyword/pageNum/pageSize，总数在 x-total-count 响应头）；
 * 系统指令为全量加载 + 前端过滤分页。serverTotal 仅在个人 tab 有值。
 */
const serverTotal = ref<number | null>(null)
const paginationTotal = computed(() =>
  activeTab.value === 'personal' ? (serverTotal.value ?? 0) : state.value.filtered.length
)

const pagedRows = computed(() => {
  const s = state.value
  if (activeTab.value === 'personal') return s.rows
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
const promoteVisible = ref(false)
const promoting = ref(false)
const promoteFormRef = ref<FormInstance>()
const promoteSource = ref<CommandRow | null>(null)

const roleOptions = ref<RoleOption[]>([])

const form = reactive({
  name: '',
  content: '',
  visibility: 'all' as CommandVisibility,
  roleIds: [] as number[],
})

const promoteForm = reactive({
  name: '',
  content: '',
  visibility: 'all' as CommandVisibility,
  roleIds: [] as number[],
})

const NAME_PATTERN = /^[a-zA-Z0-9一-龥_-]+$/

const nameRules = [
  { required: true, message: '请输入指令名称', trigger: 'blur' },
  {
    pattern: NAME_PATTERN,
    message: '名称只能包含字母、数字、中文、下划线和连字符',
    trigger: 'blur',
  },
]
const contentRules = [{ required: true, message: '请输入指令内容', trigger: 'blur' }]

function roleIdsRule(visibilityOf: () => CommandVisibility): FormRules['roleIds'] {
  return [{
    validator: (_rule, value: number[], callback) => {
      if (visibilityOf() === 'roles' && (!value || value.length === 0)) {
        callback(new Error('请至少选择一个角色'))
        return
      }
      callback()
    },
    trigger: 'change',
  }]
}

const formRules: FormRules = {
  name: nameRules,
  content: contentRules,
  roleIds: roleIdsRule(() => form.visibility),
}

const promoteRules: FormRules = {
  name: nameRules,
  content: contentRules,
  roleIds: roleIdsRule(() => promoteForm.visibility),
}

function applyFilter() {
  const s = state.value
  const kw = s.keyword.trim().toLowerCase()
  if (!kw) {
    s.filtered = s.rows
  } else {
    s.filtered = s.rows.filter((row) => {
      const userPart = `${row.username || ''} ${row.displayName || ''} ${row.userId ?? ''}`
      const rolePart = (row.roleNames || []).join(' ')
      return `${row.name || ''} ${row.content || ''} ${userPart} ${rolePart}`.toLowerCase().includes(kw)
    })
  }
  const maxPage = Math.max(1, Math.ceil(s.filtered.length / s.pageSize))
  if (s.currentPage > maxPage) s.currentPage = maxPage
}

function readTotalCount(headers: unknown): number {
  if (!headers || typeof headers !== 'object') return NaN
  const bag = headers as { get?: (name: string) => unknown } & Record<string, unknown>
  const raw = typeof bag.get === 'function' ? bag.get('x-total-count') : bag['x-total-count']
  const value = Array.isArray(raw) ? raw[0] : raw
  return Number(value)
}

let fetchSeq = 0
async function loadActiveTab() {
  const seq = ++fetchSeq
  const tab = activeTab.value
  loading.value = true
  try {
    if (tab === 'personal') {
      // 服务端分页 + keyword 过滤（后端对 name/content 做 LIKE），总数在 x-total-count 响应头
      const { result, headers } = await apiGetWithHeaders<any[]>('/admin/user-commands', {
        params: {
          pageNum: tabStates.personal.currentPage,
          pageSize: tabStates.personal.pageSize,
          keyword: tabStates.personal.keyword.trim() || undefined,
        },
      })
      if (seq !== fetchSeq) return
      const headerTotal = readTotalCount(headers)
      serverTotal.value = Number.isFinite(headerTotal) ? headerTotal : (result.data || []).length
      tabStates.personal.rows = result.data || []
    } else {
      const { data } = await api.get('/admin/system-commands')
      if (seq !== fetchSeq) return
      tabStates.system.rows = data || []
      applyFilter()
    }
  } catch {
    // interceptor handles toast
  } finally {
    if (seq === fetchSeq) loading.value = false
  }
}

function handleTabChange(tab: string | number) {
  serverTotal.value = null
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
  if (activeTab.value === 'personal') {
    serverTotal.value = null
    loadActiveTab()
  } else {
    applyFilter()
  }
}

function handleReset() {
  state.value.keyword = ''
  state.value.currentPage = 1
  if (activeTab.value === 'personal') {
    serverTotal.value = null
    loadActiveTab()
  } else {
    applyFilter()
  }
}

function handleSizeChange() {
  state.value.currentPage = 1
  if (activeTab.value === 'personal') {
    serverTotal.value = null
    loadActiveTab()
  }
}

function handlePageChange() {
  if (activeTab.value === 'personal') loadActiveTab()
}

function userLabel(row: CommandRow) {
  return row.displayName || row.username || `用户#${row.userId}`
}

function visibilityLabel(row: CommandRow) {
  if (row.visibility === 'roles') {
    const names = (row.roleNames || []).filter(Boolean)
    return names.length > 0 ? names.join('、') : COMMAND_VISIBILITY_LABELS.roles
  }
  return COMMAND_VISIBILITY_LABELS.all
}

function detailVisibility(row: CommandRow) {
  if (row.visibility !== 'roles') return COMMAND_VISIBILITY_LABELS.all
  const names = (row.roleNames || []).filter(Boolean)
  return names.length > 0 ? `${COMMAND_VISIBILITY_LABELS.roles}：${names.join('、')}` : COMMAND_VISIBILITY_LABELS.roles
}

async function ensureRoleOptions() {
  if (roleOptions.value.length > 0) return
  const { data } = await api.get('/admin/system-commands/role-options')
  roleOptions.value = data || []
}

function visibilityPayload(visibility: CommandVisibility, roleIds: number[]) {
  if (visibility === 'roles') return { visibility, roleIds }
  return { visibility: 'all' as const }
}

function openDetail(row: CommandRow) {
  detailRow.value = row
  detailVisible.value = true
}

function openPromote(row: CommandRow) {
  promoteSource.value = row
  promoteForm.name = row.name || ''
  promoteForm.content = row.content || ''
  promoteForm.visibility = 'all'
  promoteForm.roleIds = []
  void ensureRoleOptions()
  promoteVisible.value = true
}

function openPromoteFromDetail() {
  const row = detailRow.value
  if (!row) return
  detailVisible.value = false
  openPromote(row)
}

async function handlePromote() {
  const source = promoteSource.value
  if (source?.userId == null || source.id == null) return
  const valid = await promoteFormRef.value?.validate().catch(() => false)
  if (!valid) return

  promoting.value = true
  try {
    await api.post(`/admin/user-commands/${source.userId}/${source.id}/promote`, {
      name: promoteForm.name.trim(),
      content: promoteForm.content,
      ...visibilityPayload(promoteForm.visibility, promoteForm.roleIds),
    })
    ElMessage.success('已添加到系统指令')
    promoteVisible.value = false
  } catch {
    // interceptor handles toast
  } finally {
    promoting.value = false
  }
}

function openCreate() {
  isEdit.value = false
  editingId.value = null
  form.name = ''
  form.content = ''
  form.visibility = 'all'
  form.roleIds = []
  void ensureRoleOptions()
  formVisible.value = true
}

function openEdit(row: CommandRow) {
  isEdit.value = true
  editingId.value = row.id ?? null
  form.name = row.name || ''
  form.content = row.content || ''
  form.visibility = row.visibility === 'roles' ? 'roles' : 'all'
  form.roleIds = row.visibility === 'roles' ? [...(row.roleIds || [])] : []
  void ensureRoleOptions()
  formVisible.value = true
}

async function handleSubmit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  const payload = {
    name: form.name.trim(),
    content: form.content,
    ...visibilityPayload(form.visibility, form.roleIds),
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
