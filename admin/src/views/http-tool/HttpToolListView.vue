<template>
  <div class="http-tool-page">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>自定义工具清单</span>
          <div class="header-actions">
            <el-button type="primary" @click="openCreateDialog">
              <el-icon><Plus /></el-icon>
              新建工具
            </el-button>
            <el-button :loading="loading" @click="loadRecords"><el-icon><Refresh /></el-icon></el-button>
          </div>
        </div>
      </template>

      <el-alert type="info" :closable="false" class="list-hint">
        工具由管理员统一配置，并在「Agent 管理」中关联到具体 Agent；Agent 会话经
        <code>http_describe</code> 查看参数、<code>http_call</code> 发起调用，请求由服务端直连目标地址。
        可写工具（只读关闭）调用时<strong>没有审批确认</strong>，请只封装可信端点并先用「测试」验证。
      </el-alert>

      <el-form :inline="true" class="search-form">
        <el-form-item label="关键字">
          <el-input v-model="filters.keyword" clearable placeholder="工具名 / 展示名" style="width: 220px" @keyup.enter="handleSearch" />
        </el-form-item>
        <el-form-item label="启用态">
          <el-select v-model="filters.enabled" clearable placeholder="全部" style="width: 120px" @change="handleSearch">
            <el-option label="已启用" :value="true" />
            <el-option label="已停用" :value="false" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">查询</el-button>
          <el-button @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>

      <el-table v-loading="loading" :data="records">
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="name" label="工具名" min-width="150" show-overflow-tooltip />
        <el-table-column prop="displayName" label="展示名" min-width="130" show-overflow-tooltip />
        <el-table-column label="端点" min-width="260" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="method-tag" :class="methodClass(row.method)">{{ row.method }}</span>
            {{ row.url }}
          </template>
        </el-table-column>
        <el-table-column label="只读" width="80">
          <template #default="{ row }">
            <el-tag :type="row.readOnly ? 'success' : 'warning'" size="small">{{ row.readOnly ? '只读' : '可写' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="启用" width="80">
          <template #default="{ row }">
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{ row.enabled ? '启用' : '停用' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="timeoutMs" label="超时(ms)" width="100" />
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }">{{ formatDateTime(row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <el-tooltip :content="cardTestTooltip(row)" :show-after="300">
              <span>
                <el-button link type="primary" size="small" :disabled="hasSensitiveHeader(row)" @click="openTestDrawer(row)">测试</el-button>
              </span>
            </el-tooltip>
            <el-button link type="primary" size="small" @click="toggleEnabled(row)">
              {{ row.enabled ? '停用' : '启用' }}
            </el-button>
            <el-button link type="primary" size="small" @click="openEditDialog(row)">编辑</el-button>
            <el-popconfirm title="确认删除该工具？关联它的 Agent 将无法再调用。" @confirm="confirmDelete(row)">
              <template #reference>
                <el-button link type="danger" size="small">删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>

      <ResponsivePagination
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[20, 50, 100]"
        @current-change="loadRecords"
        @size-change="handleSizeChange"
      />
    </el-card>

    <el-card class="stats-card">
      <template #header>
        <div class="card-header">
          <span>调用统计</span>
          <div class="header-actions">
            <el-input v-model="statsSlug" clearable placeholder="按工具名筛选" style="width: 200px" @keyup.enter="loadStats" @clear="loadStats" />
            <el-button :loading="statsLoading" @click="loadStats"><el-icon><Refresh /></el-icon></el-button>
          </div>
        </div>
      </template>

      <el-alert type="info" :closable="false" class="stats-hint">
        统计来源为运行轨迹中 http_call 的工具调用记录（按内层工具名聚合），仅交互会话产生数据。
      </el-alert>

      <el-table v-loading="statsLoading" :data="stats">
        <el-table-column prop="slug" label="工具名" min-width="180" show-overflow-tooltip />
        <el-table-column prop="calls" label="调用次数" width="110" />
        <el-table-column prop="errors" label="失败次数" width="110" />
        <el-table-column label="失败率" width="100">
          <template #default="{ row }">
            <span :class="{ 'fail-text': row.failRate >= 0.5 }">{{ formatRate(row.failRate) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="users" label="调用用户数" width="110" />
        <el-table-column label="首次调用" width="170">
          <template #default="{ row }">{{ formatDateTime(row.firstAt) }}</template>
        </el-table-column>
        <el-table-column label="最近调用" width="170">
          <template #default="{ row }">{{ formatDateTime(row.lastAt) }}</template>
        </el-table-column>
      </el-table>
      <div v-if="!statsLoading && stats.length === 0" class="stats-empty">暂无调用记录</div>
    </el-card>

    <el-dialog
      v-model="dialogVisible"
      :title="isEditing ? '编辑自定义工具' : '新建自定义工具'"
      width="720px"
      append-to-body
      @closed="resetForm"
    >
      <el-form :model="form" label-position="top">
        <div class="form-row">
          <el-form-item label="工具名（slug）" :error="nameError" class="form-cell">
            <el-input
              v-model="form.name"
              placeholder="小写字母开头，仅含小写字母/数字/下划线"
              :disabled="isEditing"
              maxlength="64"
              @input="validateName"
            />
          </el-form-item>
          <el-form-item label="展示名" class="form-cell">
            <el-input v-model="form.displayName" placeholder="给模型看的中文名称" maxlength="128" />
          </el-form-item>
        </div>
        <el-form-item label="用途说明（写入 Agent 提示词，1~1000 字）">
          <el-input
            v-model="form.description"
            type="textarea"
            :rows="2"
            maxlength="1000"
            show-word-limit
            placeholder="说明这个工具做什么、什么时候该用，如：查询指定城市未来天气"
          />
        </el-form-item>
        <div class="form-row">
          <el-form-item label="请求方法" class="form-cell form-cell-method">
            <el-select v-model="form.method" @change="onMethodChange">
              <el-option v-for="method in HTTP_METHODS" :key="method" :label="method" :value="method" />
            </el-select>
          </el-form-item>
          <el-form-item label="超时（毫秒，1000~60000）" class="form-cell">
            <el-input-number v-model="form.timeoutMs" :min="1000" :max="60000" :step="1000" controls-position="right" />
          </el-form-item>
        </div>
        <el-form-item label="URL" :error="urlError">
          <el-input v-model="form.url" placeholder="https://api.example.com/v1/query" maxlength="1024" @input="validateUrl" />
        </el-form-item>

        <div class="section-title">
          <span>请求头</span>
          <el-button link type="primary" @click="addHeaderRow">+ 添加请求头</el-button>
        </div>
        <div v-for="(row, index) in form.headers" :key="`header-${index}`" class="kv-row">
          <el-input v-model="row.key" placeholder="名称，如 Authorization" class="kv-key" maxlength="64" />
          <el-input
            v-model="row.value"
            :type="row.sensitive ? 'password' : 'text'"
            :placeholder="row.sensitive ? '已加密（留空保存原值）' : '值'"
            class="kv-value"
            maxlength="4096"
            show-password
          />
          <el-checkbox v-model="row.sensitive" class="kv-sensitive">敏感</el-checkbox>
          <el-button link type="danger" @click="removeHeaderRow(index)">删除</el-button>
        </div>
        <p class="section-hint">
          勾选「敏感」的值加密存储、保存后不再回显；编辑时保持掩码 <code>******</code> 表示不修改，清空则表示删除该请求头。
        </p>

        <div class="section-title">
          <span>参数定义</span>
          <el-button link type="primary" @click="addParamRow">+ 添加参数</el-button>
        </div>
        <div v-for="(row, index) in form.params" :key="`param-${index}`" class="param-row">
          <el-input v-model="row.name" placeholder="参数名" class="param-name" maxlength="64" />
          <el-input v-model="row.label" placeholder="中文说明" class="param-label" maxlength="128" />
          <el-select v-model="row.type" class="param-type">
            <el-option v-for="type in PARAM_TYPES" :key="type" :label="type" :value="type" />
          </el-select>
          <el-checkbox v-model="row.required" class="param-required">必填</el-checkbox>
          <el-input v-model="row.defaultValue" placeholder="默认值（选填）" class="param-default" maxlength="500" />
          <el-button link type="danger" @click="removeParamRow(index)">删除</el-button>
        </div>
        <p class="section-hint">
          参数会拼进 <code>http_call(tool, arguments)</code>；URL 查询串与 body 模板里的
          <code v-pre>{{参数名}}</code> 占位符会被替换。
        </p>

        <el-form-item label="请求体模板（选填，仅 POST/PUT/PATCH/DELETE 需要）">
          <el-input
            v-model="form.bodyTemplate"
            type="textarea"
            :rows="3"
            maxlength="65536"
            placeholder='{"city": "{{city}}", "days": {{days}}}'
          />
        </el-form-item>

        <div class="form-row form-row-switches">
          <el-form-item label="只读（GET/HEAD 默认开启）" class="form-cell">
            <el-switch v-model="form.readOnly" />
          </el-form-item>
          <el-form-item label="启用" class="form-cell">
            <el-switch v-model="form.enabled" />
          </el-form-item>
        </div>
        <el-alert v-if="!form.readOnly" type="warning" :closable="false" class="write-warning">
          该工具可写：Agent 调用时<strong>没有审批确认</strong>，请确认端点可信。
        </el-alert>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button :disabled="!canSave" @click="openTestFromDialog">测试调用</el-button>
        <el-button type="primary" :disabled="!canSave || submitting" :loading="submitting" @click="handleSubmit">
          {{ isEditing ? '保存' : '创建' }}
        </el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="testVisible" title="测试调用" size="560px" append-to-body @closed="resetTest">
      <template #header>
        <span class="drawer-title">测试调用 · {{ testForm.displayName || testForm.name }}</span>
      </template>
      <p class="test-hint">
        使用当前草稿实调一次（不落库），SSRF 判定与 Agent 正式调用完全一致。
      </p>
      <el-alert v-if="hasMaskedHeader" type="warning" :closable="false" class="test-mask-hint">
        草稿含已加密的敏感请求头：试运行需要真实值，请回到编辑器填写后再测试。
      </el-alert>
      <el-form :model="testValues" label-position="top">
        <el-form-item
          v-for="param in testForm.params"
          :key="param.name"
          :label="`${param.label || param.name}（${param.name}${param.required ? '，必填' : ''}）`"
        >
          <el-switch v-if="param.type === 'boolean'" v-model="testValues[param.name]" />
          <el-input-number
            v-else-if="param.type === 'number'"
            v-model="testValues[param.name]"
            controls-position="right"
            class="test-input"
          />
          <el-input v-else v-model="testValues[param.name]" :placeholder="param.defaultValue || ''" />
        </el-form-item>
        <div v-if="testForm.params.length === 0" class="test-no-params">该工具无参数</div>
      </el-form>
      <div class="test-actions">
        <el-button
          type="primary"
          :disabled="testing || hasMaskedHeader"
          :title="hasMaskedHeader ? '请先回填敏感请求头的真实值' : ''"
          :loading="testing"
          @click="runTest"
        >
          发起调用
        </el-button>
      </div>
      <div v-if="testResult" class="test-result" :class="{ 'test-result-error': testResult.error }">
        <div class="test-result-head">
          <span v-if="testResult.error" class="test-status test-status-error">失败</span>
          <span v-else class="test-status" :class="statusClass(testResult.status)">HTTP {{ testResult.status }}</span>
          <span v-if="testResult.durationMs != null" class="test-duration">{{ testResult.durationMs }} ms</span>
        </div>
        <div v-if="testResult.notice" class="test-notice">{{ testResult.notice }}</div>
        <pre class="test-body">{{ testResult.error || testResult.body }}</pre>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, reactive, ref } from 'vue'
import { Plus, Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { api } from '../../api'
import { formatDateTime } from '../../utils/datetime'
import ResponsivePagination from '../../components/ResponsivePagination.vue'

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const
const PARAM_TYPES = ['string', 'number', 'boolean'] as const
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/
/** 与后端 http-tool.service 的 HEADER_KEY_RE 保持一致（不含点号）。 */
const HEADER_KEY_RE = /^[A-Za-z0-9_-]+$/
/** 与后端 HEADER_VALUE_MASK 一致：敏感请求头回显掩码。 */
const HEADER_VALUE_MASK = '******'

interface HeaderRow {
  key: string
  value: string
  sensitive: boolean
}

interface ParamRow {
  name: string
  label: string
  type: string
  required: boolean
  defaultValue: string
}

interface HttpToolRow {
  id: number
  name: string
  displayName: string
  description: string
  method: string
  url: string
  headers: HeaderRow[]
  bodyTemplate: string | null
  readOnly: boolean
  enabled: boolean
  timeoutMs: number
  params: Array<ParamRow & { id?: number; sortOrder: number }>
  createdAt: string | null
  updatedAt: string | null
}

interface HttpToolStatRow {
  slug: string
  calls: number
  errors: number
  failRate: number
  users: number
  firstAt: string | null
  lastAt: string | null
}

interface TestResult {
  status?: number
  body?: string
  truncated?: boolean
  notice?: string | null
  displayName?: string
  durationMs?: number
  error?: string
}

const loading = ref(false)
const records = ref<HttpToolRow[]>([])
const total = ref(0)
const currentPage = ref(1)
const pageSize = ref(20)
const filters = reactive({
  keyword: '',
  enabled: '' as '' | boolean
})

const statsLoading = ref(false)
const stats = ref<HttpToolStatRow[]>([])
const statsSlug = ref('')

const dialogVisible = ref(false)
const isEditing = ref(false)
const editingId = ref<number | null>(null)
const submitting = ref(false)
const nameError = ref('')
const urlError = ref('')

const emptyForm = () => ({
  name: '',
  displayName: '',
  description: '',
  method: 'GET',
  url: '',
  headers: [] as HeaderRow[],
  bodyTemplate: '',
  readOnly: true,
  timeoutMs: 15000,
  enabled: true,
  params: [] as ParamRow[],
})

const form = ref(emptyForm())

const testVisible = ref(false)
const testing = ref(false)
const testResult = ref<TestResult | null>(null)
const testValues = ref<Record<string, unknown>>({})
const testForm = ref({ name: '', displayName: '', params: [] as ParamRow[] })

/** 草稿含未回显的敏感请求头（掩码值）：执行内核拒掩码，试运行前需回填真实值。 */
const hasMaskedHeader = computed(() =>
  form.value.headers.some((row) => row.sensitive && row.value === HEADER_VALUE_MASK)
)

/** 已存工具是否带加密请求头：列表 VO 只回显掩码，直接试运行必然被内核拒绝。 */
function hasSensitiveHeader(item: HttpToolRow) {
  return item.headers.some((header) => header.sensitive)
}

function cardTestTooltip(item: HttpToolRow) {
  return hasSensitiveHeader(item)
    ? '该工具含加密请求头，请从「编辑」填写真实值后在编辑器内测试'
    : '测试调用'
}

function methodClass(method: string): string {
  const upper = (method || '').toUpperCase()
  if (upper === 'GET' || upper === 'HEAD') return 'method-get'
  if (upper === 'DELETE') return 'method-delete'
  return 'method-write'
}

function formatRate(rate: number): string {
  const value = Number(rate ?? 0) * 100
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`
}

function statusClass(status?: number) {
  if (status == null) return ''
  return status >= 200 && status < 300 ? 'test-status-ok' : 'test-status-error'
}

function validateName() {
  const name = form.value.name.trim()
  if (!name) {
    nameError.value = ''
    return
  }
  if (!TOOL_NAME_RE.test(name)) {
    nameError.value = '小写字母开头，仅含小写字母/数字/下划线，最长 64 字符'
    return
  }
  nameError.value = ''
}

function validateUrl() {
  const url = form.value.url.trim()
  if (!url) {
    urlError.value = ''
    return
  }
  try {
    const parsed = new URL(url)
    urlError.value = parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? ''
      : '仅支持 http:// 或 https://'
  } catch {
    urlError.value = 'URL 格式不正确'
  }
}

function onMethodChange(method: string) {
  // 与后端 inferReadOnlyByMethod 一致：GET/HEAD 预推断只读
  const upper = method.toUpperCase()
  if (upper === 'GET' || upper === 'HEAD') form.value.readOnly = true
}

function addHeaderRow() {
  if (form.value.headers.length >= 20) {
    ElMessage.warning('请求头最多 20 个')
    return
  }
  form.value.headers.push({ key: '', value: '', sensitive: false })
}

function removeHeaderRow(index: number) {
  form.value.headers.splice(index, 1)
}

function addParamRow() {
  if (form.value.params.length >= 50) {
    ElMessage.warning('参数最多 50 个')
    return
  }
  form.value.params.push({ name: '', label: '', type: 'string', required: false, defaultValue: '' })
}

function removeParamRow(index: number) {
  form.value.params.splice(index, 1)
}

const canSave = computed(() => {
  const f = form.value
  if (!TOOL_NAME_RE.test(f.name.trim()) || nameError.value) return false
  if (!f.displayName.trim() || !f.description.trim()) return false
  if (!f.url.trim() || urlError.value) return false
  for (const row of f.headers) {
    if (row.key.trim() === '') continue
    if (!HEADER_KEY_RE.test(row.key.trim())) return false
  }
  for (const row of f.params) {
    if (row.name.trim() === '') continue
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(row.name.trim())) return false
  }
  return true
})

function buildParams(page: number, size: number): Record<string, unknown> {
  return {
    page,
    size,
    keyword: filters.keyword.trim() || undefined,
    enabled: filters.enabled === '' ? undefined : filters.enabled
  }
}

async function loadRecords(): Promise<void> {
  loading.value = true
  try {
    const { data } = await api.get('/admin/http-tools', { params: buildParams(currentPage.value, pageSize.value) })
    records.value = data?.records || []
    total.value = data?.total || 0
  } catch {
    records.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

async function loadStats(): Promise<void> {
  statsLoading.value = true
  try {
    const { data } = await api.get('/admin/http-tools/stats', {
      params: { slug: statsSlug.value.trim() || undefined }
    })
    stats.value = Array.isArray(data) ? data : []
  } catch {
    stats.value = []
  } finally {
    statsLoading.value = false
  }
}

function handleSearch(): void {
  currentPage.value = 1
  void loadRecords()
}

function handleReset(): void {
  filters.keyword = ''
  filters.enabled = ''
  handleSearch()
}

function handleSizeChange(): void {
  currentPage.value = 1
  void loadRecords()
}

/** 编辑器草稿 → 提交体（请求头 / 参数按行过滤空行）。 */
function toPayload(includeArguments?: Record<string, unknown>) {
  const headers: Array<{ key: string; value: string }> = []
  for (const row of form.value.headers) {
    const key = row.key.trim()
    if (key === '') continue
    headers.push({ key, value: row.value })
  }
  const params = form.value.params
    .filter((row) => row.name.trim() !== '')
    .map((row) => ({
      name: row.name.trim(),
      label: row.label.trim(),
      type: row.type,
      required: row.required,
      defaultValue: row.defaultValue.trim() === '' ? null : row.defaultValue.trim(),
    }))
  const payload = {
    name: form.value.name.trim(),
    displayName: form.value.displayName.trim(),
    description: form.value.description.trim(),
    method: form.value.method,
    url: form.value.url.trim(),
    headers,
    bodyTemplate: form.value.bodyTemplate.trim() === '' ? null : form.value.bodyTemplate,
    readOnly: form.value.readOnly,
    timeoutMs: form.value.timeoutMs,
    enabled: form.value.enabled,
    params,
    ...(includeArguments ? { arguments: includeArguments } : {}),
  }
  return payload
}

function openCreateDialog() {
  isEditing.value = false
  editingId.value = null
  form.value = emptyForm()
  nameError.value = ''
  urlError.value = ''
  dialogVisible.value = true
}

function openEditDialog(item: HttpToolRow) {
  isEditing.value = true
  editingId.value = item.id
  form.value = {
    name: item.name,
    displayName: item.displayName,
    description: item.description,
    method: item.method,
    url: item.url,
    headers: item.headers.map((header) => ({ ...header })),
    bodyTemplate: item.bodyTemplate ?? '',
    readOnly: item.readOnly,
    timeoutMs: item.timeoutMs,
    enabled: item.enabled,
    params: item.params.map((param) => ({
      name: param.name,
      label: param.label,
      type: param.type,
      required: param.required,
      defaultValue: param.defaultValue ?? '',
    })),
  }
  nameError.value = ''
  urlError.value = ''
  dialogVisible.value = true
}

function resetForm() {
  form.value = emptyForm()
  isEditing.value = false
  editingId.value = null
  nameError.value = ''
  urlError.value = ''
}

async function handleSubmit() {
  if (!canSave.value) return
  submitting.value = true
  try {
    if (isEditing.value && editingId.value != null) {
      await api.put(`/admin/http-tools/${editingId.value}`, toPayload())
      ElMessage.success('工具已更新')
    } else {
      await api.post('/admin/http-tools', toPayload())
      ElMessage.success('工具已创建')
    }
    dialogVisible.value = false
    await loadRecords()
  } catch {
    // handled by interceptor
  } finally {
    submitting.value = false
  }
}

async function confirmDelete(item: HttpToolRow) {
  try {
    await api.delete(`/admin/http-tools/${item.id}`)
    ElMessage.success(`已删除 ${item.displayName}`)
    await loadRecords()
  } catch {
    // handled by interceptor
  }
}

async function toggleEnabled(item: HttpToolRow) {
  try {
    await api.put(`/admin/http-tools/${item.id}/enabled`, { enabled: !item.enabled })
    ElMessage.success(item.enabled ? '已停用' : '已启用')
    await loadRecords()
  } catch {
    // handled by interceptor
  }
}

function openTestDrawer(item: HttpToolRow) {
  // 已保存的工具：直接用落库定义试运行（不经过编辑器草稿）
  form.value = {
    name: item.name,
    displayName: item.displayName,
    description: item.description,
    method: item.method,
    url: item.url,
    headers: item.headers.map((header) => ({ ...header })),
    bodyTemplate: item.bodyTemplate ?? '',
    readOnly: item.readOnly,
    timeoutMs: item.timeoutMs,
    enabled: item.enabled,
    params: item.params.map((param) => ({
      name: param.name,
      label: param.label,
      type: param.type,
      required: param.required,
      defaultValue: param.defaultValue ?? '',
    })),
  }
  syncTestFormFromCurrent()
  testVisible.value = true
}

function openTestFromDialog() {
  if (!canSave.value) return
  syncTestFormFromCurrent()
  testVisible.value = true
}

function syncTestFormFromCurrent() {
  testForm.value = {
    name: form.value.name,
    displayName: form.value.displayName,
    params: form.value.params.filter((row) => row.name.trim() !== ''),
  }
  const values: Record<string, unknown> = {}
  for (const param of testForm.value.params) {
    if (param.type === 'boolean') {
      values[param.name] = param.defaultValue === 'true'
    } else if (param.type === 'number') {
      const parsed = Number(param.defaultValue)
      values[param.name] = param.defaultValue.trim() !== '' && Number.isFinite(parsed) ? parsed : undefined
    } else {
      values[param.name] = param.defaultValue
    }
  }
  testValues.value = values
  testResult.value = null
}

function resetTest() {
  testValues.value = {}
  testResult.value = null
  testForm.value = { name: '', displayName: '', params: [] }
}

async function runTest() {
  testing.value = true
  try {
    const { data } = await api.post('/admin/http-tools/test', toPayload(testValues.value))
    testResult.value = data
  } catch {
    // handled by interceptor
  } finally {
    testing.value = false
  }
}

onMounted(() => {
  void loadRecords()
  void loadStats()
})

onActivated(() => {
  void loadStats()
})
</script>

<style scoped>
.card-header,
.header-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.list-hint {
  margin-bottom: 12px;
}

.list-hint code {
  padding: 0 3px;
  border-radius: 3px;
  background: var(--el-fill-color);
  font-family: monospace;
}

.stats-card {
  margin-top: 16px;
}

.stats-hint {
  margin-bottom: 12px;
}

.stats-empty {
  padding: 24px 0;
  text-align: center;
  color: var(--mao-muted);
  font-size: 13px;
}

.fail-text {
  color: var(--el-color-danger);
  font-weight: 600;
}

.method-tag {
  display: inline-block;
  margin-right: 6px;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 12px;
  font-weight: 600;
}

.method-get {
  background: var(--el-fill-color-dark);
  color: var(--mao-muted);
}

.method-write {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.method-delete {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

.form-row {
  display: flex;
  gap: 12px;
}

.form-cell {
  flex: 1;
  min-width: 0;
}

.form-cell-method {
  max-width: 160px;
}

.form-row-switches .form-cell {
  max-width: 220px;
}

.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 4px 0 8px;
  font-size: 13px;
  font-weight: 600;
}

.section-hint {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--mao-muted);
  line-height: 1.6;
}

.section-hint code {
  padding: 0 3px;
  border-radius: 3px;
  background: var(--el-fill-color);
  font-family: monospace;
}

.kv-row,
.param-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.kv-key,
.param-name {
  flex: 0 0 200px;
}

.kv-value,
.param-label {
  flex: 1;
  min-width: 0;
}

.param-type {
  flex: 0 0 110px;
}

.param-default {
  flex: 0 0 160px;
}

.param-required,
.kv-sensitive {
  flex: 0 0 auto;
}

.write-warning {
  margin-bottom: 8px;
}

.drawer-title {
  font-size: 14px;
  font-weight: 600;
}

.test-hint {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--mao-muted);
  line-height: 1.6;
}

.test-no-params {
  padding: 12px;
  font-size: 12px;
  color: var(--mao-muted);
  text-align: center;
}

.test-mask-hint {
  margin-bottom: 12px;
}

.test-input {
  width: 100%;
}

.test-actions {
  margin: 8px 0 16px;
}

.test-result {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  overflow: hidden;
}

.test-result-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  background: var(--el-fill-color-light);
  font-size: 12px;
}

.test-status {
  font-weight: 600;
  font-family: monospace;
}

.test-status-ok {
  color: var(--el-color-primary);
}

.test-status-error {
  color: var(--el-color-danger);
}

.test-duration {
  color: var(--mao-muted);
  font-family: monospace;
}

.test-notice {
  padding: 6px 10px;
  font-size: 12px;
  color: var(--mao-muted);
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.test-body {
  margin: 0;
  padding: 10px;
  max-height: 360px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.6;
  font-family: monospace;
  white-space: pre-wrap;
  word-break: break-all;
}

.test-result-error .test-body {
  color: var(--el-color-danger);
}
</style>
