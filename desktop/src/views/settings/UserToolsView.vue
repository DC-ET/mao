<template>
  <div class="user-tools-page">
    <div class="page-header">
      <h1 class="page-title">我的工具</h1>
      <p class="page-desc">
        把自己常用的 HTTP 接口封装成 Agent 可调用的工具。工具定义（URL / 方法 / 参数 / 请求头）保存后，
        Agent 通过 <code>http_describe</code> 查看参数、<code>http_call</code> 发起调用；请求由服务端直连目标地址。
      </p>
    </div>

    <div class="hint-card">
      <el-icon :size="14"><InfoFilled /></el-icon>
      <span>
        敏感请求头（Token / Key 等）加密存储、保存后不回显；可写工具（<code>read_only</code> 关闭）调用时
        <strong>没有审批确认</strong>，请只封装可信端点并先用「测试调用」验证。服务端默认拒绝访问内网地址，
        确需访问请联系管理员在系统设置中放行网段。
      </span>
    </div>

    <button class="create-btn" @click="openCreateDialog">
      <el-icon><Plus /></el-icon>
      新增工具
    </button>

    <div v-if="loading" class="empty-state">加载中...</div>
    <div v-else-if="tools.length === 0" class="empty-state">
      暂无自定义工具，点击上方按钮添加
    </div>
    <div v-else class="tool-list">
      <div v-for="item in tools" :key="item.id" class="tool-card">
        <div class="tool-header">
          <div class="tool-title">
            <span class="tool-name">{{ item.displayName }}</span>
            <span class="tool-slug">{{ item.name }}</span>
            <el-tag :type="item.readOnly ? 'success' : 'warning'" size="small" effect="light">
              {{ item.readOnly ? '只读' : '可写' }}
            </el-tag>
            <el-tag v-if="!item.enabled" type="info" size="small" effect="plain">已停用</el-tag>
          </div>
          <div class="tool-actions">
            <template v-if="deletingId === item.id">
              <button class="action-btn action-btn-danger" title="确认删除" @click="confirmDelete(item)">
                <el-icon :size="14"><Check /></el-icon>
              </button>
              <button class="action-btn" title="取消" @click="deletingId = null">
                <el-icon :size="14"><Close /></el-icon>
              </button>
            </template>
            <template v-else>
              <el-tooltip :content="cardTestTooltip(item)" :show-after="300">
                <span class="action-btn-slot">
                  <button class="action-btn" :disabled="hasSensitiveHeader(item)" @click="openTestDrawer(item)">
                    <el-icon :size="14"><VideoPlay /></el-icon>
                  </button>
                </span>
              </el-tooltip>
              <el-tooltip :content="item.enabled ? '停用' : '启用'" :show-after="300">
                <button class="action-btn" @click="toggleEnabled(item)">
                  <el-icon :size="14"><SwitchButton /></el-icon>
                </button>
              </el-tooltip>
              <el-tooltip content="编辑" :show-after="300">
                <button class="action-btn" @click="openEditDialog(item)">
                  <el-icon :size="14"><Edit /></el-icon>
                </button>
              </el-tooltip>
              <el-tooltip content="删除" :show-after="300">
                <button class="action-btn action-btn-danger" @click="deletingId = item.id!">
                  <el-icon :size="14"><Delete /></el-icon>
                </button>
              </el-tooltip>
            </template>
          </div>
        </div>
        <div class="tool-endpoint">
          <span class="tool-method" :class="methodClass(item.method)">{{ item.method }}</span>
          <span class="tool-url">{{ item.url }}</span>
        </div>
        <div class="tool-meta">
          <span class="tool-desc">{{ item.description }}</span>
        </div>
        <div class="tool-meta">
          <span v-if="item.params.length > 0" class="tool-params">
            参数：{{ item.params.map((param) => param.name + (param.required ? '*' : '')).join('、') }}
          </span>
          <span v-else class="tool-params">无参数</span>
          <span class="tool-time">更新于 {{ formatTime(item.updatedAt) }}</span>
        </div>
      </div>
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="isEditing ? '编辑自定义工具' : '新增自定义工具'"
      width="680px"
      class="user-tool-dialog management-dialog"
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
          <button class="link-btn" type="button" @click="addHeaderRow">+ 添加请求头</button>
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
          <button class="link-btn link-btn-danger" type="button" @click="removeHeaderRow(index)">删除</button>
        </div>
        <p class="section-hint">
          勾选「敏感」的值加密存储、保存后不再回显；编辑时保持掩码 <code>******</code> 表示不修改，清空则表示删除该请求头。
        </p>

        <div class="section-title">
          <span>参数定义</span>
          <button class="link-btn" type="button" @click="addParamRow">+ 添加参数</button>
        </div>
        <div v-for="(row, index) in form.params" :key="`param-${index}`" class="param-row">
          <el-input v-model="row.name" placeholder="参数名" class="param-name" maxlength="64" />
          <el-input v-model="row.label" placeholder="中文说明" class="param-label" maxlength="128" />
          <el-select v-model="row.type" class="param-type">
            <el-option v-for="type in PARAM_TYPES" :key="type" :label="type" :value="type" />
          </el-select>
          <el-checkbox v-model="row.required" class="param-required">必填</el-checkbox>
          <el-input v-model="row.defaultValue" placeholder="默认值（选填）" class="param-default" maxlength="500" />
          <button class="link-btn link-btn-danger" type="button" @click="removeParamRow(index)">删除</button>
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
        <div v-if="!form.readOnly" class="write-warning">
          <el-icon :size="14"><WarningFilled /></el-icon>
          <span>该工具可写：Agent 调用时<strong>没有审批确认</strong>，请确认端点可信。</span>
        </div>
      </el-form>
      <template #footer>
        <button class="dialog-btn dialog-btn-cancel" @click="dialogVisible = false">取消</button>
        <button class="dialog-btn dialog-btn-test" :disabled="!canSave" @click="openTestFromDialog">测试调用</button>
        <button class="dialog-btn dialog-btn-confirm" :disabled="!canSave || submitting" @click="handleSubmit">
          {{ submitting ? '保存中…' : (isEditing ? '保存' : '创建') }}
        </button>
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
        <button
          class="dialog-btn dialog-btn-confirm"
          :disabled="testing || hasMaskedHeader"
          :title="hasMaskedHeader ? '请先回填敏感请求头的真实值' : ''"
          @click="runTest"
        >
          {{ testing ? '调用中…' : '发起调用' }}
        </button>
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
import { computed, onMounted, ref } from 'vue'
import { Plus, Check, Close, Edit, Delete, InfoFilled, VideoPlay, SwitchButton, WarningFilled } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import {
  createUserTool,
  deleteUserTool,
  listUserTools,
  setUserToolEnabled,
  testUserTool,
  updateUserTool,
  type UserToolTestResult,
  type UserToolView,
} from '../../api'

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const
const PARAM_TYPES = ['string', 'number', 'boolean'] as const
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/
/** 与后端 user-tool.service 的 HEADER_KEY_RE 保持一致（不含点号）。 */
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

const loading = ref(false)
const tools = ref<UserToolView[]>([])
const dialogVisible = ref(false)
const isEditing = ref(false)
const editingId = ref<number | null>(null)
const deletingId = ref<number | null>(null)
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
const testResult = ref<UserToolTestResult | null>(null)
const testValues = ref<Record<string, unknown>>({})
const testForm = ref({ name: '', displayName: '', params: [] as ParamRow[] })

/** 草稿含未回显的敏感请求头（掩码值）：执行内核拒掩码，试运行前需回填真实值。 */
const hasMaskedHeader = computed(() =>
  form.value.headers.some((row) => row.sensitive && row.value === HEADER_VALUE_MASK)
)

/** 已存工具是否带加密请求头：列表 VO 只回显掩码，直接试运行必然被内核拒绝。 */
function hasSensitiveHeader(item: UserToolView) {
  return item.headers.some((header) => header.sensitive)
}

function cardTestTooltip(item: UserToolView) {
  return hasSensitiveHeader(item)
    ? '该工具含加密请求头，请从「编辑」填写真实值后在编辑器内测试'
    : '测试调用'
}

function formatTime(value?: string | null) {
  if (!value) return '-'
  return value.replace('T', ' ').slice(0, 16)
}

function methodClass(method: string) {
  const upper = method.toUpperCase()
  if (upper === 'GET' || upper === 'HEAD') return 'method-get'
  if (upper === 'DELETE') return 'method-delete'
  return 'method-write'
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

async function fetchTools() {
  loading.value = true
  try {
    tools.value = await listUserTools()
  } finally {
    loading.value = false
  }
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

function openEditDialog(item: UserToolView) {
  isEditing.value = true
  editingId.value = item.id ?? null
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
      await updateUserTool(editingId.value, toPayload())
      ElMessage.success('工具已更新')
    } else {
      await createUserTool(toPayload())
      ElMessage.success('工具已创建')
    }
    dialogVisible.value = false
    await fetchTools()
  } catch {
    // handled by interceptor
  } finally {
    submitting.value = false
  }
}

async function confirmDelete(item: UserToolView) {
  try {
    await deleteUserTool(item.id!)
    ElMessage.success(`已删除 ${item.displayName}`)
    deletingId.value = null
    await fetchTools()
  } catch {
    // handled by interceptor
  }
}

async function toggleEnabled(item: UserToolView) {
  try {
    await setUserToolEnabled(item.id!, !item.enabled)
    ElMessage.success(item.enabled ? '已停用' : '已启用')
    await fetchTools()
  } catch {
    // handled by interceptor
  }
}

function openTestDrawer(item: UserToolView) {
  // 已保存的工具：直接用落库定义试运行（不经过编辑器草稿）
  form.value = openEditFormFromView(item)
  syncTestFormFromCurrent()
  testVisible.value = true
}

function openEditFormFromView(item: UserToolView) {
  return {
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
    testResult.value = await testUserTool(toPayload(testValues.value))
  } catch {
    // handled by interceptor
  } finally {
    testing.value = false
  }
}

onMounted(() => {
  fetchTools()
})
</script>

<style scoped>
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
  line-height: 1.6;
  max-width: 720px;
}

.page-desc code,
.section-hint code {
  padding: 0 3px;
  border-radius: 3px;
  background: var(--aw-surface-hover);
  font-family: var(--aw-font-mono, monospace);
}

.hint-card {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 720px;
  margin-bottom: 16px;
  padding: 10px 12px;
  border: 1px solid var(--aw-divider-soft);
  border-radius: 8px;
  background: var(--aw-surface);
  color: var(--aw-ink-muted);
  font-size: 12px;
  line-height: 1.6;
}

.hint-card code {
  padding: 0 3px;
  border-radius: 3px;
  background: var(--aw-surface-hover);
  font-family: var(--aw-font-mono, monospace);
}

.create-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: var(--aw-btn-height);
  padding: var(--aw-btn-padding);
  border: none;
  border-radius: var(--aw-radius-xs);
  background: var(--aw-primary);
  color: #fff;
  font-size: var(--aw-text-fine);
  font-weight: 500;
  cursor: pointer;
  margin-bottom: 20px;
}

.create-btn:hover {
  opacity: 0.85;
}

.empty-state {
  text-align: center;
  padding: 48px 16px;
  color: var(--aw-ink-muted);
  font-size: 13px;
}

.tool-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 720px;
}

.tool-card {
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider-soft);
  border-radius: 8px;
  padding: 12px 14px;
}

.tool-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.tool-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.tool-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--aw-ink);
}

.tool-slug {
  font-size: 12px;
  color: var(--aw-ink-muted);
  font-family: var(--aw-font-mono, monospace);
}

.tool-actions {
  display: flex;
  gap: 4px;
  flex: 0 0 auto;
}

.action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: var(--aw-surface-hover);
  color: var(--aw-ink-muted);
  cursor: pointer;
}

.action-btn:hover {
  color: var(--aw-ink);
}

/* tooltip 触发器包裹层：让禁用态按钮也能收到 hover（禁用按钮自身不派发鼠标事件） */
.action-btn-slot {
  display: inline-flex;
}

.action-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.action-btn-danger:hover {
  color: var(--aw-danger);
}

.tool-endpoint {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-family: var(--aw-font-mono, monospace);
  margin-bottom: 4px;
  min-width: 0;
}

.tool-method {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 600;
  font-size: 11px;
}

.method-get {
  background: var(--aw-surface-hover);
  color: var(--aw-ink-muted);
}

.method-write {
  background: color-mix(in srgb, var(--aw-primary) 18%, transparent);
  color: var(--aw-primary);
}

.method-delete {
  background: color-mix(in srgb, var(--aw-danger) 18%, transparent);
  color: var(--aw-danger);
}

.tool-url {
  color: var(--aw-ink-muted);
  word-break: break-all;
}

.tool-meta {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--aw-ink-muted);
}

.tool-desc {
  word-break: break-all;
}

.tool-params {
  font-family: var(--aw-font-mono, monospace);
}

.tool-time {
  color: var(--aw-ink-muted-80);
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
  color: var(--aw-ink);
}

.section-hint {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--aw-ink-muted);
  line-height: 1.6;
}

.link-btn {
  border: none;
  background: none;
  padding: 0;
  font-size: 12px;
  color: var(--aw-primary);
  cursor: pointer;
}

.link-btn-danger {
  color: var(--aw-danger);
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
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--aw-danger) 35%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--aw-danger) 8%, transparent);
  color: var(--aw-danger);
  font-size: 12px;
  line-height: 1.6;
  margin-bottom: 8px;
}

.dialog-btn {
  height: var(--aw-btn-height);
  padding: var(--aw-btn-padding);
  border-radius: var(--aw-radius-xs);
  border: 1px solid var(--aw-divider-soft);
  background: var(--aw-surface);
  color: var(--aw-ink);
  font-size: var(--aw-text-fine);
  cursor: pointer;
}

.dialog-btn-confirm {
  margin-left: 8px;
  border-color: var(--aw-primary);
  background: var(--aw-primary);
  color: #fff;
}

.dialog-btn-test {
  margin-left: 8px;
  border-color: var(--aw-primary);
  color: var(--aw-primary);
}

.dialog-btn-cancel {
  margin-left: auto;
}

.dialog-btn-confirm:disabled,
.dialog-btn-test:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.drawer-title {
  font-size: 14px;
  font-weight: 600;
}

.test-hint {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--aw-ink-muted);
  line-height: 1.6;
}

.test-no-params {
  padding: 12px;
  font-size: 12px;
  color: var(--aw-ink-muted);
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
  border: 1px solid var(--aw-divider-soft);
  border-radius: 8px;
  overflow: hidden;
}

.test-result-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  background: var(--aw-surface-hover);
  font-size: 12px;
}

.test-status {
  font-weight: 600;
  font-family: var(--aw-font-mono, monospace);
}

.test-status-ok {
  color: var(--aw-primary);
}

.test-status-error {
  color: var(--aw-danger);
}

.test-duration {
  color: var(--aw-ink-muted);
  font-family: var(--aw-font-mono, monospace);
}

.test-notice {
  padding: 6px 10px;
  font-size: 12px;
  color: var(--aw-ink-muted);
  border-bottom: 1px solid var(--aw-divider-soft);
}

.test-body {
  margin: 0;
  padding: 10px;
  max-height: 360px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.6;
  font-family: var(--aw-font-mono, monospace);
  color: var(--aw-ink);
  white-space: pre-wrap;
  word-break: break-all;
}

.test-result-error .test-body {
  color: var(--aw-danger);
}
</style>
