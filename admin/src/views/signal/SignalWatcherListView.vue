<template>
  <el-card>
    <template #header>
      <div class="card-header">
        <span>信号哨兵</span>
        <div class="header-actions">
          <el-button :loading="loading" @click="loadRecords"><el-icon><Refresh /></el-icon></el-button>
        </div>
      </div>
    </template>

    <el-form :inline="true" class="search-form">
      <el-form-item label="状态">
        <el-select v-model="filters.status" clearable placeholder="全部" style="width: 130px" @change="handleSearch">
          <el-option v-for="item in statusOptions" :key="item" :label="statusLabel(item)" :value="item" />
        </el-select>
      </el-form-item>
      <el-form-item label="属主 ID">
        <el-input v-model="filters.userId" clearable style="width: 120px" @keyup.enter="handleSearch" />
      </el-form-item>
      <el-form-item label="判定模式">
        <el-select v-model="filters.compareMode" clearable placeholder="全部" style="width: 130px" @change="handleSearch">
          <el-option v-for="item in compareModeOptions" :key="item" :label="compareModeLabel(item)" :value="item" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="handleSearch">查询</el-button>
        <el-button @click="handleReset">重置</el-button>
      </el-form-item>
    </el-form>

    <el-table v-loading="loading" :data="records">
      <el-table-column prop="id" label="ID" width="80" />
      <el-table-column prop="name" label="名称" min-width="140" show-overflow-tooltip />
      <el-table-column label="属主" min-width="120">
        <template #default="{ row }">{{ row.username || row.userId }}</template>
      </el-table-column>
      <el-table-column label="探测地址" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">{{ row.method }} {{ row.url }}</template>
      </el-table-column>
      <el-table-column prop="method" label="方法" width="70" />
      <el-table-column prop="intervalMinutes" label="间隔(分)" width="90" />
      <el-table-column label="判定模式" width="110">
        <template #default="{ row }">{{ compareModeLabel(row.compareMode) }}</template>
      </el-table-column>
      <el-table-column label="触发方式" width="120">
        <template #default="{ row }">{{ triggerModeLabel(row.triggerMode) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="statusTagType(row.status)" size="small">{{ statusLabel(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="连续失败" width="90">
        <template #default="{ row }">
          <span :class="{ 'fail-text': row.consecutiveFailures > 0 }">{{ row.consecutiveFailures }}</span>
        </template>
      </el-table-column>
      <el-table-column label="上次轮询" width="160">
        <template #default="{ row }">{{ formatDateTime(row.lastCheckedAt) }}</template>
      </el-table-column>
      <el-table-column label="上次变化" width="160">
        <template #default="{ row }">{{ formatDateTime(row.lastChangedAt) }}</template>
      </el-table-column>
      <el-table-column label="上次变化内容" min-width="240" show-overflow-tooltip>
        <template #default="{ row }">
          <span v-if="row.lastChangeOldSnippet != null || row.lastChangeNewSnippet != null">{{ lastChangeText(row) }}</span>
          <span v-else>-</span>
        </template>
      </el-table-column>
      <el-table-column label="创建时间" width="160">
        <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="90" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row)">详情</el-button>
        </template>
      </el-table-column>
    </el-table>

    <ResponsivePagination
      class="pagination"
      v-model:current-page="currentPage"
      v-model:page-size="pageSize"
      :total="total"
      :page-sizes="[20, 50, 100]"
      @current-change="loadRecords"
      @size-change="handleSizeChange"
    />
  </el-card>

  <el-drawer
    v-model="detailVisible"
    :title="detailTitle"
    :size="isMobile ? '100%' : '760px'"
    destroy-on-close
  >
    <div v-loading="detailLoading" class="detail-body">
      <el-tabs v-model="detailTab">
        <el-tab-pane label="配置详情" name="config">
          <el-descriptions v-if="detail" :column="isMobile ? 1 : 2" size="small" border>
            <el-descriptions-item label="ID">{{ detail.id }}</el-descriptions-item>
            <el-descriptions-item label="名称">{{ detail.name }}</el-descriptions-item>
            <el-descriptions-item label="属主">{{ detail.username || `#${detail.userId}` }}</el-descriptions-item>
            <el-descriptions-item label="状态">
              <el-tag :type="statusTagType(detail.status)" size="small">{{ statusLabel(detail.status) }}</el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="Agent">{{ agentLabel(detail.agentId) }}</el-descriptions-item>
            <el-descriptions-item label="轮询间隔">{{ detail.intervalMinutes }} 分钟</el-descriptions-item>
            <el-descriptions-item label="判定模式">{{ compareModeLabel(detail.compareMode) }}</el-descriptions-item>
            <el-descriptions-item label="触发方式">{{ triggerModeLabel(detail.triggerMode) }}</el-descriptions-item>
            <el-descriptions-item label="探测地址" :span="isMobile ? 1 : 2">
              <code class="probe-url">{{ detail.method }} {{ detail.url }}</code>
            </el-descriptions-item>
            <el-descriptions-item v-if="detail.compareMode === 'JSON_FIELD'" label="JSON 路径">
              {{ detail.jsonPath || '-' }}
            </el-descriptions-item>
            <el-descriptions-item v-if="detail.triggerMode === 'REUSE_SESSION'" label="复用会话">
              <el-button v-if="detail.reuseSessionId" link type="primary" @click="goSession(detail.reuseSessionId)">
                #{{ detail.reuseSessionId }}
              </el-button>
              <span v-else>-</span>
            </el-descriptions-item>
            <el-descriptions-item label="连续失败">
              <span :class="{ 'fail-text': detail.consecutiveFailures > 0 }">{{ detail.consecutiveFailures }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="上次轮询">{{ formatDateTime(detail.lastCheckedAt) }}</el-descriptions-item>
            <el-descriptions-item label="上次变化">{{ formatDateTime(detail.lastChangedAt) }}</el-descriptions-item>
            <el-descriptions-item label="最近判定值">{{ detail.lastValueHash?.slice(0, 12) || '-' }}</el-descriptions-item>
            <el-descriptions-item label="创建时间">{{ formatDateTime(detail.createdAt) }}</el-descriptions-item>
            <el-descriptions-item label="请求头" :span="isMobile ? 1 : 2">
              <div v-if="headerEntries.length > 0" class="header-list">
                <div v-for="[key, value] in headerEntries" :key="key"><code>{{ key }}</code>: {{ value }}</div>
              </div>
              <span v-else>-</span>
            </el-descriptions-item>
            <el-descriptions-item label="请求体" :span="isMobile ? 1 : 2">
              {{ detail.hasBody ? `已配置（${detail.bodyLength} 字符，不回显内容）` : '未配置' }}
            </el-descriptions-item>
            <el-descriptions-item label="提示词模板" :span="isMobile ? 1 : 2">
              <pre class="prompt-block">{{ detail.promptTemplate }}</pre>
            </el-descriptions-item>
          </el-descriptions>
          <el-empty v-else-if="!detailLoading" description="加载失败" :image-size="48" />
        </el-tab-pane>

        <el-tab-pane :label="checksTotal > 0 ? `轮询记录（${checksTotal}）` : '轮询记录'" name="checks">
          <el-table v-loading="checksLoading" :data="checks" size="small">
            <template #empty><el-empty description="暂无轮询记录" :image-size="48" /></template>
            <el-table-column label="时间" width="170">
              <template #default="{ row }">{{ formatDateTime(row.checkedAt) }}</template>
            </el-table-column>
            <el-table-column label="状态码" width="80">
              <template #default="{ row }">{{ row.httpStatus ?? '-' }}</template>
            </el-table-column>
            <el-table-column label="结果" width="80">
              <template #default="{ row }">
                <el-tag v-if="row.error" type="danger" size="small">失败</el-tag>
                <el-tag v-else-if="row.changed === 1" type="warning" size="small">变化</el-tag>
                <el-tag v-else type="success" size="small">未变</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="耗时" width="90">
              <template #default="{ row }">{{ row.durationMs != null ? `${row.durationMs}ms` : '-' }}</template>
            </el-table-column>
            <el-table-column label="触发/告警" min-width="140" show-overflow-tooltip>
              <template #default="{ row }">
                <el-button v-if="row.triggeredSessionId" link type="primary" @click="goSession(row.triggeredSessionId)">
                  会话 #{{ row.triggeredSessionId }}
                </el-button>
                <span v-if="row.warning" class="warn-text">{{ warningLabel(row.warning) }}</span>
                <span v-if="!row.triggeredSessionId && !row.warning">-</span>
              </template>
            </el-table-column>
            <el-table-column label="详情" min-width="160" show-overflow-tooltip>
              <template #default="{ row }">
                <span :class="{ 'fail-text': row.error }">{{ checkDetailText(row) }}</span>
              </template>
            </el-table-column>
          </el-table>
          <ResponsivePagination
            v-if="checksTotal > 0"
            class="pagination"
            v-model:current-page="checksPage"
            :page-size="CHECKS_PAGE_SIZE"
            :total="checksTotal"
            layout="total, prev, pager, next"
            @current-change="handleChecksPageChange"
          />
        </el-tab-pane>
      </el-tabs>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Refresh } from '@element-plus/icons-vue'
import { api } from '../../api'
import type { SignalCompareMode, SignalTriggerMode, SignalWatcherStatus, SignalWatcherWarning } from '@mao/contracts'
import { formatSignalChangeValue, formatSignalCheckDetail } from '@mao/contracts'
import { formatDateTime } from '../../utils/datetime'
import { useBreakpoint } from '../../composables/useBreakpoint'
import ResponsivePagination from '../../components/ResponsivePagination.vue'

interface WatcherRow {
  id: number
  name: string
  userId: number
  username: string | null
  url: string
  method: string
  intervalMinutes: number
  compareMode: SignalCompareMode
  triggerMode: SignalTriggerMode
  status: SignalWatcherStatus
  lastCheckedAt: string | null
  lastChangedAt: string | null
  /** 上次判定内容片段（admin 列表透出，供失败「上次正常值」用）。 */
  lastValueSnippet: string | null
  /** 上次变化的旧/新值（列表卡一句的数据源；从未变化 / 已重置基线时为 null）。 */
  lastChangeOldSnippet: string | null
  lastChangeNewSnippet: string | null
  consecutiveFailures: number
  createdAt: string | null
}

/** 详情接口返回：列表字段 + 完整配置（敏感值已脱敏）+ 属主展示名。 */
interface WatcherDetail extends WatcherRow {
  agentId: number
  headers: Record<string, string>
  hasBody: boolean
  bodyLength: number
  jsonPath: string | null
  promptTemplate: string
  lastValueHash: string | null
  reuseSessionId: number | null
}

interface CheckRow {
  id?: number
  checkedAt: string | null
  httpStatus: number | null
  valueHash: string | null
  /** 本次判定所对照的上次值 / 本次值片段（V183）；失败行与上线前历史行为 null。 */
  oldValueSnippet: string | null
  newValueSnippet: string | null
  changed: number
  triggeredSessionId: number | null
  error: string | null
  durationMs: number | null
  warning: SignalWatcherWarning | null
}

const statusOptions: readonly SignalWatcherStatus[] = ['ACTIVE', 'PAUSED', 'DISABLED']
const compareModeOptions: readonly SignalCompareMode[] = ['HASH', 'JSON_FIELD', 'STATUS_CODE']

const STATUS_LABELS: Record<SignalWatcherStatus, string> = {
  ACTIVE: '运行中',
  PAUSED: '已暂停',
  DISABLED: '已停用'
}

const COMPARE_MODE_LABELS: Record<SignalCompareMode, string> = {
  HASH: '内容哈希',
  JSON_FIELD: 'JSON 字段',
  STATUS_CODE: '状态码'
}

const TRIGGER_MODE_LABELS: Record<SignalTriggerMode, string> = {
  NEW_SESSION: '每次新建会话',
  REUSE_SESSION: '复用会话'
}

const STATUS_TAGS: Record<SignalWatcherStatus, 'success' | 'warning' | 'danger'> = {
  ACTIVE: 'success',
  PAUSED: 'warning',
  DISABLED: 'danger'
}

const loading = ref(false)
const records = ref<WatcherRow[]>([])
const total = ref(0)
const currentPage = ref(1)
const pageSize = ref(20)
const filters = reactive({
  status: '',
  userId: '',
  compareMode: ''
})

// ── 详情抽屉（配置详情 + 轮询记录，只读）────────────────────────────────────

const WARNING_LABELS: Record<SignalWatcherWarning, string> = {
  TRIGGER_RATE_LIMITED: '触发频次超限'
}

/** 轮询记录每页条数（与桌面端「轮询记录」保持一致）。 */
const CHECKS_PAGE_SIZE = 20

const router = useRouter()
const { isMobile } = useBreakpoint()

const detailVisible = ref(false)
const detailLoading = ref(false)
const detailTab = ref('config')
const detail = ref<WatcherDetail | null>(null)
const checks = ref<CheckRow[]>([])
const checksTotal = ref(0)
const checksPage = ref(1)
const checksLoading = ref(false)
const agentNames = ref<Record<number, string>>({})

const headerEntries = computed(() => Object.entries(detail.value?.headers || {}))
const detailTitle = computed(() => (detail.value ? `信号哨兵 · ${detail.value.name}` : '信号哨兵详情'))

/** 列表行「上次变化内容」一句（§5.8，与桌面同一口径）。 */
function lastChangeText(row: WatcherRow): string {
  return formatSignalChangeValue({
    compareMode: row.compareMode,
    oldText: row.lastChangeOldSnippet,
    newText: row.lastChangeNewSnippet,
    jsonPath: null,
  })
}

function detailCompareMode(): SignalCompareMode {
  return detail.value?.compareMode ?? 'HASH'
}

function detailJsonPath(): string | null {
  return detail.value?.jsonPath ?? null
}

/** 轮询记录「详情」列文案（§5.6 与桌面同列名、同文案格式；触发失败行附第二行新旧值对）。 */
function checkDetailText(row: { changed: number; error: string | null; oldValueSnippet: string | null; newValueSnippet: string | null }): string {
  return formatSignalCheckDetail({
    compareMode: detailCompareMode(),
    changed: row.changed,
    error: row.error,
    oldValueSnippet: row.oldValueSnippet,
    newValueSnippet: row.newValueSnippet,
    jsonPath: detailJsonPath(),
  })
}

function warningLabel(warning: SignalWatcherWarning): string {
  return WARNING_LABELS[warning] ?? warning
}

function agentLabel(agentId: number | null): string {
  if (agentId == null) return '-'
  const name = agentNames.value[agentId]
  return name ? `${name}（#${agentId}）` : `#${agentId}`
}

function goSession(sessionId: number): void {
  detailVisible.value = false
  void router.push(`/sessions/${sessionId}`)
}

/** Agent 名称映射懒加载：取不到只回落成 #id，不影响详情本身。 */
async function ensureAgentNames(): Promise<void> {
  if (Object.keys(agentNames.value).length > 0) return
  try {
    const { data } = await api.get('/agents', { params: { includeDisabled: true } })
    const map: Record<number, string> = {}
    for (const agent of (data || []) as Array<{ id?: number; name?: string }>) {
      if (agent?.id != null && agent.name) map[agent.id] = agent.name
    }
    agentNames.value = map
  } catch { /* 拦截器已提示失败；保留数字 id 展示 */ }
}

async function loadDetail(id: number): Promise<void> {
  detailLoading.value = true
  try {
    const { data } = await api.get(`/admin/signal-watchers/${id}`)
    detail.value = data || null
  } catch {
    detail.value = null
  } finally {
    detailLoading.value = false
  }
}

async function loadChecks(id: number): Promise<void> {
  checksLoading.value = true
  try {
    const { data } = await api.get(`/admin/signal-watchers/${id}/checks`, {
      params: { page: checksPage.value, size: CHECKS_PAGE_SIZE }
    })
    checks.value = data?.records || []
    checksTotal.value = data?.total || 0
  } catch {
    checks.value = []
    checksTotal.value = 0
  } finally {
    checksLoading.value = false
  }
}

function handleChecksPageChange(): void {
  if (detail.value) void loadChecks(detail.value.id)
}

async function openDetail(row: WatcherRow): Promise<void> {
  detailVisible.value = true
  detailTab.value = 'config'
  detail.value = null
  checks.value = []
  checksTotal.value = 0
  checksPage.value = 1
  await Promise.all([loadDetail(row.id), loadChecks(row.id)])
  void ensureAgentNames()
}

function statusLabel(status: SignalWatcherStatus): string {
  return STATUS_LABELS[status] ?? status
}

function compareModeLabel(mode: SignalCompareMode): string {
  return COMPARE_MODE_LABELS[mode] ?? mode
}

function triggerModeLabel(mode: SignalTriggerMode): string {
  return TRIGGER_MODE_LABELS[mode] ?? mode
}

function statusTagType(status: SignalWatcherStatus): 'success' | 'warning' | 'danger' | 'info' {
  return STATUS_TAGS[status] ?? 'info'
}

function buildParams(page: number, size: number): Record<string, unknown> {
  const userId = filters.userId.trim()
  return {
    page,
    size,
    status: filters.status || undefined,
    compareMode: filters.compareMode || undefined,
    userId: userId === '' ? undefined : Number(userId)
  }
}

async function loadRecords(): Promise<void> {
  loading.value = true
  try {
    const { data } = await api.get('/admin/signal-watchers', { params: buildParams(currentPage.value, pageSize.value) })
    records.value = data?.records || []
    total.value = data?.total || 0
  } catch {
    records.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

function handleSearch(): void {
  currentPage.value = 1
  void loadRecords()
}

function handleReset(): void {
  filters.status = ''
  filters.userId = ''
  filters.compareMode = ''
  handleSearch()
}

function handleSizeChange(): void {
  currentPage.value = 1
  void loadRecords()
}

onMounted(() => {
  void loadRecords()
})

onActivated(() => {
  void loadRecords()
})
</script>

<style scoped>
.pagination {
  margin-top: 16px;
  justify-content: flex-end;
}
.card-header,
.header-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.fail-text {
  color: var(--el-color-danger);
  font-weight: 600;
}

.warn-text {
  color: var(--el-color-warning);
  font-size: 12px;
}

.detail-cell {
  white-space: pre-wrap;
  word-break: break-all;
}

/* ── 详情抽屉 ─────────────────────────────────────────────────────────── */

.detail-body {
  min-height: 200px;
}

.probe-url {
  font-size: 12px;
  word-break: break-all;
  white-space: pre-wrap;
}

.header-list {
  font-size: 12px;
  line-height: 1.8;
}

.prompt-block {
  margin: 0;
  padding: 8px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--el-fill-color-light);
  border-radius: 4px;
}
</style>
