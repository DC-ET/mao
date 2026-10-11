<template>
  <div class="signal-page">
    <div class="page-header">
      <h1 class="page-title">信号哨兵</h1>
      <p class="page-desc">
        按固定间隔探测外部接口，判定值变化时自动开一次 Agent 会话：适合盯汇率、库存、发布状态、接口健康度等「有变化才需要处理」的信号。
        每次变化都会产生一次 Agent 运行并计入用量，间隔不宜设得过小。
      </p>
    </div>

    <section class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">哨兵列表</h2>
          <p class="card-desc">
            连续失败 {{ DISABLE_AFTER_FAILURES }} 次会自动停用并站内通知；停用后需手动重新启用。每次触发都会新建一次 Agent 会话。
          </p>
        </div>
        <button v-if="watchers.length < MAX_WATCHERS" class="create-btn" @click="openCreateDialog">
          <el-icon><Plus /></el-icon> 新建哨兵
        </button>
        <span v-else class="limit-hint">已达单用户上限 {{ MAX_WATCHERS }} 个</span>
      </div>
      <div v-if="loading" class="empty-state">加载中...</div>
      <div v-else-if="watchers.length === 0" class="empty-state">暂无哨兵，点击右上角新建</div>
      <div v-else class="item-list">
        <div v-for="watcher in watchers" :key="watcher.id" class="item-card">
          <div class="item-row">
            <div class="item-title">
              {{ watcher.name }}
              <span class="badge" :class="statusClass(watcher.status)">{{ statusLabel(watcher.status) }}</span>
              <span class="badge badge-muted">{{ compareModeLabel(watcher.compareMode) }}</span>
            </div>
            <div class="item-actions">
              <el-tooltip content="立即测试探针" :show-after="300">
                <button class="action-btn" :disabled="testingId === watcher.id" @click="runTest(watcher)">
                  <el-icon :size="14"><Aim /></el-icon>
                </button>
              </el-tooltip>
              <el-tooltip content="轮询记录" :show-after="300">
                <button class="action-btn" @click="openChecks(watcher)"><el-icon :size="14"><Tickets /></el-icon></button>
              </el-tooltip>
              <el-tooltip content="编辑" :show-after="300">
                <button class="action-btn" @click="openEditDialog(watcher)"><el-icon :size="14"><Edit /></el-icon></button>
              </el-tooltip>
              <el-tooltip :content="watcher.status === 'PAUSED' ? '启用' : '暂停'" :show-after="300">
                <button class="action-btn" @click="toggleStatus(watcher)">
                  <el-icon :size="14"><VideoPlay v-if="watcher.status !== 'ACTIVE'" /><VideoPause v-else /></el-icon>
                </button>
              </el-tooltip>
              <button
                class="action-btn action-btn-danger"
                :title="confirmDeleteId === watcher.id ? '确认删除' : '删除'"
                @click="confirmDelete(watcher)"
              >
                <el-icon :size="14"><Delete /></el-icon>
              </button>
            </div>
          </div>
          <div class="item-meta">
            <span class="mono url-text">{{ watcher.method }} {{ watcher.url }}</span>
            <span>间隔 {{ watcher.intervalMinutes }} 分钟</span>
            <span v-if="watcher.compareMode === 'JSON_FIELD'">路径 {{ watcher.jsonPath }}</span>
            <span>上次变化：{{ watcher.lastChangedAt ? formatTime(watcher.lastChangedAt) : '从未' }}</span>
            <span>上次轮询：{{ watcher.lastCheckedAt ? formatTime(watcher.lastCheckedAt) : '从未' }}</span>
            <span v-if="watcher.consecutiveFailures > 0" class="fail-text">连续失败 {{ watcher.consecutiveFailures }} 次</span>
          </div>
        </div>
      </div>
    </section>

    <!-- ── 新建 / 编辑 ──────────────────────────────────────────── -->
    <el-dialog
      :model-value="dialogVisible"
      :title="editing ? '编辑哨兵' : '新建哨兵'"
      width="620px"
      class="signal-dialog"
      @update:model-value="(val: boolean) => { if (!val) closeDialog() }"
    >
      <el-form label-width="92px" label-position="right">
        <el-form-item label="名称" required>
          <el-input v-model="form.name" maxlength="128" show-word-limit placeholder="例如：美元汇率变化" />
        </el-form-item>
        <el-form-item label="目标 Agent" required>
          <el-select v-model="form.agentId" placeholder="选择 Agent" filterable style="width: 100%">
            <el-option v-for="agent in agents" :key="agent.id" :label="agent.name" :value="agent.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="探测地址" required>
          <el-input v-model="form.url" placeholder="http:// 或 https://，不支持 localhost 与内网地址" />
        </el-form-item>
        <el-form-item label="方法">
          <el-radio-group v-model="form.method">
            <el-radio value="GET">GET</el-radio>
            <el-radio value="POST">POST</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="请求体" v-if="form.method === 'POST'">
          <el-input
            v-model="form.body"
            type="textarea"
            :rows="3"
            :placeholder="editing ? `留空不修改（当前已保存 ${form.bodyLength} 字符）` : 'POST 方法必填，上限 64KB'"
          />
        </el-form-item>
        <el-form-item label="请求头">
          <div class="header-editor">
            <div v-for="(pair, index) in form.headers" :key="index" class="header-row">
              <el-input v-model="pair.key" placeholder="Header 名" />
              <el-input
                v-model="pair.value"
                :placeholder="editing && pair.masked ? '留空不修改' : '值'"
              />
              <button class="action-btn action-btn-danger" @click="removeHeaderRow(index)">
                <el-icon :size="14"><Delete /></el-icon>
              </button>
            </div>
            <button class="add-header-btn" @click="addHeaderRow">
              <el-icon :size="12"><Plus /></el-icon> 添加请求头
            </button>
          </div>
        </el-form-item>
        <el-form-item label="轮询间隔" required>
          <el-input-number v-model="form.intervalMinutes" :min="1" :max="1440" :step="1" />
          <span class="field-hint">分钟，1~1440。失败后按倍数退避重试。</span>
        </el-form-item>
        <el-form-item label="判定模式" required>
          <el-radio-group v-model="form.compareMode">
            <el-radio value="HASH">内容哈希</el-radio>
            <el-radio value="JSON_FIELD">JSON 字段</el-radio>
            <el-radio value="STATUS_CODE">HTTP 状态码</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="form.compareMode === 'JSON_FIELD'" label="提取路径" required>
          <el-input v-model="form.jsonPath" placeholder="例如 data.list.0.price 或 $.data.price" />
        </el-form-item>
        <el-form-item label="提示词模板" required>
          <el-input
            v-model="form.promptTemplate"
            type="textarea"
            :rows="4"
            maxlength="2000"
            show-word-limit
            placeholder="变化时发给 Agent 的内容，可用 {name} {url} {diff} 占位"
          />
          <span class="field-hint">每次变化 = 一次 Agent 运行，会计入用量。</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <button class="dialog-btn dialog-btn-cancel" @click="closeDialog">取消</button>
        <button class="dialog-btn dialog-btn-confirm" :disabled="submitting || !canSubmit" @click="submitForm">
          {{ submitting ? '保存中...' : '保存' }}
        </button>
      </template>
    </el-dialog>

    <!-- ── 轮询记录 ─────────────────────────────────────────────── -->
    <el-drawer v-model="checksVisible" title="轮询记录" size="560px">
      <div v-if="checksLoading" class="empty-state">加载中...</div>
      <div v-else-if="checks.rows.length === 0" class="empty-state">暂无轮询记录</div>
      <template v-else>
        <el-table :data="checks.rows" size="small">
          <el-table-column label="时间" width="150">
            <template #default="{ row }">{{ row.checkedAt ? formatTime(row.checkedAt) : '-' }}</template>
          </el-table-column>
          <el-table-column label="状态码" width="80">
            <template #default="{ row }">{{ row.httpStatus ?? '-' }}</template>
          </el-table-column>
          <el-table-column label="结果" width="120">
            <template #default="{ row }">
              <span v-if="row.error" class="badge badge-danger">失败</span>
              <span v-else-if="row.changed === 1" class="badge badge-warn">变化</span>
              <span v-else class="badge badge-ok">未变</span>
            </template>
          </el-table-column>
          <el-table-column label="耗时" width="80">
            <template #default="{ row }">{{ row.durationMs != null ? `${row.durationMs}ms` : '-' }}</template>
          </el-table-column>
          <el-table-column label="触发/告警" min-width="140">
            <template #default="{ row }">
              <a v-if="row.triggeredSessionId" class="session-link" @click="openSession(row.triggeredSessionId)">
                会话 #{{ row.triggeredSessionId }}
              </a>
              <span v-if="row.warning" class="warn-text">{{ warningLabel(row.warning) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="详情" min-width="160">
            <template #default="{ row }">
              <span class="error-text">{{ row.error || row.valueHash?.slice(0, 12) || '-' }}</span>
            </template>
          </el-table-column>
        </el-table>
        <div class="pager">
          <el-pagination
            :current-page="checksPage"
            :page-size="20"
            :total="checks.total"
            layout="prev, pager, next"
            small
            @current-change="(page: number) => { checksPage = page; void fetchChecks() }"
          />
        </div>
      </template>
    </el-drawer>

    <!-- ── 立即测试结果 ─────────────────────────────────────────── -->
    <el-dialog v-model="testVisible" title="探针测试结果" width="520px" class="signal-dialog">
      <div v-if="testResult" class="test-body">
        <p class="test-line">
          HTTP 状态：<b>{{ testResult.httpStatus ?? '未取得' }}</b>
          <span class="field-hint">耗时 {{ testResult.durationMs }}ms</span>
        </p>
        <p v-if="testResult.error" class="test-error">{{ testResult.error }}</p>
        <template v-else>
          <p class="test-line">
            判定可用：<b>{{ testResult.parseOk ? '是' : '否' }}</b>
          </p>
          <p v-if="testResult.parseOk" class="test-line mono">判定哈希：{{ testResult.valueHash }}</p>
          <div class="test-sample-label">响应体样本（前 200 字）</div>
          <pre class="test-sample">{{ testResult.sample }}</pre>
        </template>
      </div>
      <template #footer>
        <button class="dialog-btn dialog-btn-confirm" @click="testVisible = false">知道了</button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { Plus, Delete, Edit, Aim, Tickets, VideoPause, VideoPlay } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import {
  api,
  listSignalWatchers,
  createSignalWatcher,
  updateSignalWatcher,
  deleteSignalWatcher,
  setSignalWatcherStatus,
  listSignalWatcherChecks,
  testSignalWatcher,
  type SignalWatcherView,
  type SignalWatcherCheckPage,
  type SignalWatcherTestResult,
  type SignalCompareMode,
  type SignalWatcherStatus
} from '../../api'
import {
  DISABLE_AFTER_FAILURES,
  MAX_WATCHERS,
  buildWatcherPayload,
  headerPairsFromView,
  type HeaderPair
} from './signal-watcher-form'

const router = useRouter()

interface AgentOption {
  id: number
  name: string
  enabled?: number | boolean
}

const watchers = ref<SignalWatcherView[]>([])
const agents = ref<AgentOption[]>([])
const loading = ref(false)
const testingId = ref<number | null>(null)
const confirmDeleteId = ref<number | null>(null)

const dialogVisible = ref(false)
const editing = ref(false)
const editingId = ref<number | null>(null)
const submitting = ref(false)

const form = reactive({
  name: '',
  agentId: null as number | null,
  url: '',
  method: 'GET',
  body: '',
  bodyLength: 0,
  headers: [] as HeaderPair[],
  intervalMinutes: 30,
  compareMode: 'HASH' as SignalCompareMode,
  jsonPath: '',
  promptTemplate: ''
})

const checksVisible = ref(false)
const checksLoading = ref(false)
const checksWatcherId = ref<number | null>(null)
const checks = ref<SignalWatcherCheckPage>({ rows: [], total: 0 })
const checksPage = ref(1)

const testVisible = ref(false)
const testResult = ref<SignalWatcherTestResult | null>(null)

const COMPARE_MODE_LABELS: Record<SignalCompareMode, string> = {
  HASH: '内容哈希',
  JSON_FIELD: 'JSON 字段',
  STATUS_CODE: '状态码'
}

const WARNING_LABELS: Record<string, string> = {
  TRIGGER_RATE_LIMITED: '触发频次超限'
}

function statusLabel(status: SignalWatcherStatus): string {
  if (status === 'ACTIVE') return '运行中'
  if (status === 'PAUSED') return '已暂停'
  return '已停用'
}

function statusClass(status: SignalWatcherStatus): string {
  if (status === 'ACTIVE') return 'badge-ok'
  if (status === 'PAUSED') return 'badge-warn'
  return 'badge-danger'
}

function compareModeLabel(mode: SignalCompareMode): string {
  return COMPARE_MODE_LABELS[mode] ?? mode
}

function warningLabel(warning: string): string {
  return WARNING_LABELS[warning] ?? warning
}

function formatTime(value: string | null): string {
  if (!value) return '-'
  return value.replace('T', ' ').slice(0, 16)
}

async function fetchWatchers(): Promise<void> {
  loading.value = true
  try {
    watchers.value = await listSignalWatchers()
  } catch {
    watchers.value = []
  } finally {
    loading.value = false
  }
}

async function fetchAgents(): Promise<void> {
  try {
    const { data } = await api.get('/agents')
    agents.value = ((data || []) as AgentOption[]).filter((agent) => agent.enabled !== false && agent.enabled !== 0)
  } catch {
    agents.value = []
  }
}

function resetForm(): void {
  form.name = ''
  form.agentId = null
  form.url = ''
  form.method = 'GET'
  form.body = ''
  form.bodyLength = 0
  form.headers = []
  form.intervalMinutes = 30
  form.compareMode = 'HASH'
  form.jsonPath = ''
  form.promptTemplate = ''
}

function openCreateDialog(): void {
  resetForm()
  editing.value = false
  editingId.value = null
  dialogVisible.value = true
  if (agents.value.length === 0) void fetchAgents()
}

function openEditDialog(watcher: SignalWatcherView): void {
  resetForm()
  editing.value = true
  editingId.value = watcher.id
  form.name = watcher.name
  form.agentId = watcher.agentId
  form.url = watcher.url
  form.method = watcher.method
  form.bodyLength = watcher.bodyLength
  form.intervalMinutes = watcher.intervalMinutes
  form.compareMode = watcher.compareMode
  form.jsonPath = watcher.jsonPath ?? ''
  form.promptTemplate = watcher.promptTemplate
  form.headers = headerPairsFromView(watcher.headers)
  dialogVisible.value = true
  if (agents.value.length === 0) void fetchAgents()
}

function closeDialog(): void {
  dialogVisible.value = false
}

function addHeaderRow(): void {
  form.headers.push({ key: '', value: '', masked: false })
}

function removeHeaderRow(index: number): void {
  form.headers.splice(index, 1)
}

const canSubmit = computed(() => {
  if (form.name.trim() === '' || form.agentId == null) return false
  if (form.url.trim() === '') return false
  if (form.method === 'POST' && !editing && form.body.trim() === '') return false
  if (form.compareMode === 'JSON_FIELD' && form.jsonPath.trim() === '') return false
  if (form.promptTemplate.trim() === '') return false
  return true
})

async function submitForm(): Promise<void> {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  try {
    // 编辑态：未修改的敏感字段（请求体 / 提取路径）不下发，服务端按「留空不修改」保留原值；
    // 新建态照常下发（undefined 由服务端 normalizeInput 的必填校验拦住）。
    const payload = buildWatcherPayload(form, editing.value)
    if (editing && editingId.value != null) {
      await updateSignalWatcher(editingId.value, payload)
      ElMessage.success('哨兵已更新')
    } else {
      await createSignalWatcher(payload)
      ElMessage.success('哨兵已创建')
    }
    dialogVisible.value = false
    await fetchWatchers()
  } catch {
    // handled by interceptor
  } finally {
    submitting.value = false
  }
}

async function toggleStatus(watcher: SignalWatcherView): Promise<void> {
  const next = watcher.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE'
  try {
    await setSignalWatcherStatus(watcher.id, next)
    await fetchWatchers()
  } catch {
    // handled by interceptor
  }
}

async function confirmDelete(watcher: SignalWatcherView): Promise<void> {
  if (confirmDeleteId.value !== watcher.id) {
    confirmDeleteId.value = watcher.id
    return
  }
  try {
    await ElMessageBox.confirm(
      `删除「${watcher.name}」将同时清除其轮询记录，已产生的会话不会被删除。`,
      '确认删除',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    confirmDeleteId.value = null
    return
  }
  confirmDeleteId.value = null
  try {
    await deleteSignalWatcher(watcher.id)
    ElMessage.success('哨兵已删除')
    await fetchWatchers()
  } catch {
    // handled by interceptor
  }
}

async function openChecks(watcher: SignalWatcherView): Promise<void> {
  checksWatcherId.value = watcher.id
  checksPage.value = 1
  checksVisible.value = true
  await fetchChecks()
}

async function fetchChecks(): Promise<void> {
  if (checksWatcherId.value == null) return
  checksLoading.value = true
  try {
    checks.value = await listSignalWatcherChecks(checksWatcherId.value, { page: checksPage.value, size: 20 })
  } catch {
    checks.value = { rows: [], total: 0 }
  } finally {
    checksLoading.value = false
  }
}

function openSession(sessionId: number): void {
  checksVisible.value = false
  void router.push(`/tasks/${sessionId}`)
}

async function runTest(watcher: SignalWatcherView): Promise<void> {
  testingId.value = watcher.id
  try {
    testResult.value = await testSignalWatcher(watcher.id)
    testVisible.value = true
  } catch {
    // handled by interceptor
  } finally {
    testingId.value = null
  }
}

onMounted(() => {
  void fetchWatchers()
})
</script>

<style scoped>
.signal-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page-header {
  margin-bottom: 4px;
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
  max-width: 640px;
}

.card {
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider-soft);
  border-radius: 8px;
  padding: 14px 16px;
  max-width: 860px;
}

.card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.card-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--aw-ink);
  margin: 0 0 4px;
}

.card-desc {
  font-size: 12px;
  color: var(--aw-ink-muted);
  margin: 0;
  line-height: 1.5;
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
  flex-shrink: 0;
}

.limit-hint {
  font-size: 12px;
  color: var(--aw-ink-muted);
  flex-shrink: 0;
}

.empty-state {
  text-align: center;
  padding: 28px 16px;
  color: var(--aw-ink-muted);
  font-size: 13px;
}

.item-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.item-card {
  border: 1px solid var(--aw-divider-soft);
  border-radius: 6px;
  padding: 10px 12px;
}

.item-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.item-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--aw-ink);
  flex-wrap: wrap;
}

.item-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}

.item-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--aw-ink-muted);
}

.item-meta .mono,
.item-title .mono {
  font-family: var(--aw-font-mono, monospace);
}

.url-text {
  word-break: break-all;
}

.fail-text {
  color: #d97706;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--aw-btn-height);
  height: var(--aw-btn-height);
  border: none;
  background: transparent;
  border-radius: var(--aw-radius-xs);
  cursor: pointer;
  color: var(--aw-ink-muted);
}

.action-btn:hover {
  color: var(--aw-ink);
  background: var(--aw-surface-hover);
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.action-btn-danger:hover {
  color: var(--aw-danger);
}

.badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
}

.badge-ok {
  background: rgba(34, 197, 94, 0.12);
  color: #16a34a;
}

.badge-warn {
  background: rgba(245, 158, 11, 0.14);
  color: #d97706;
}

.badge-danger {
  background: rgba(239, 68, 68, 0.12);
  color: #dc2626;
}

.badge-muted {
  background: var(--aw-surface-hover);
  color: var(--aw-ink-muted);
}

.header-editor {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}

.header-row {
  display: grid;
  grid-template-columns: 1fr 1.4fr 32px;
  gap: 6px;
  align-items: center;
}

.add-header-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  align-self: flex-start;
  height: 26px;
  padding: 0 8px;
  border: 1px dashed var(--aw-hairline);
  border-radius: var(--aw-radius-xs);
  background: transparent;
  color: var(--aw-ink-muted);
  font-size: 12px;
  cursor: pointer;
}

.add-header-btn:hover {
  color: var(--aw-ink);
  border-color: var(--aw-ink-muted);
}

.field-hint {
  font-size: 12px;
  color: var(--aw-ink-muted);
  margin-left: 8px;
}

.dialog-btn {
  height: var(--aw-btn-height);
  padding: var(--aw-btn-padding);
  border: none;
  border-radius: var(--aw-radius-xs);
  font-size: var(--aw-text-fine);
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

.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}

.session-link {
  color: var(--aw-primary);
  cursor: pointer;
}

.session-link:hover {
  text-decoration: underline;
}

.warn-text {
  display: block;
  font-size: 11px;
  color: #d97706;
}

.error-text {
  font-size: 12px;
  color: var(--aw-ink-muted);
  word-break: break-all;
}

.test-body {
  font-size: 13px;
}

.test-line {
  margin: 0 0 8px;
  color: var(--aw-ink);
}

.test-error {
  margin: 0 0 8px;
  color: #dc2626;
  font-size: 12px;
  word-break: break-all;
}

.test-sample-label {
  font-size: 12px;
  color: var(--aw-ink-muted);
  margin-bottom: 4px;
}

.test-sample {
  max-height: 220px;
  overflow: auto;
  margin: 0;
  padding: 8px;
  border-radius: var(--aw-radius-xs);
  background: var(--aw-surface-hover);
  font-size: 12px;
  font-family: var(--aw-font-mono, monospace);
  white-space: pre-wrap;
  word-break: break-all;
}
</style>

<style>
.signal-dialog .el-dialog__title {
  font-size: 15px;
  font-weight: 600;
}
</style>
