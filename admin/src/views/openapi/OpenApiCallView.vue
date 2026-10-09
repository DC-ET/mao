<template>
  <div class="openapi-call-view">
    <el-card class="stats-card">
      <div class="summary-row">
        <div class="summary-item"><span>总调用</span><strong>{{ stats?.summary.total ?? 0 }}</strong></div>
        <div class="summary-item"><span>成功率</span><strong>{{ successText }}</strong></div>
        <div class="summary-item"><span>P95 端到端</span><strong>{{ formatMs(stats?.summary.p95ExecutionMs) }}</strong></div>
        <div class="summary-item"><span>P95 排队</span><strong>{{ formatMs(stats?.summary.p95QueueWaitMs) }}</strong></div>
      </div>
      <p v-if="stats?.summary.p95Truncated" class="hint">P95 按窗口内最新 5 万条已结束调用计算。</p>
      <el-table v-if="!isMobile && stats" :data="stats.buckets" size="small" class="bucket-table">
        <el-table-column prop="bucket" :label="stats.granularity === 'token' ? 'Token' : '日期'" min-width="120" />
        <el-table-column prop="total" label="总量" width="80" />
        <el-table-column prop="completed" label="成功" width="80" />
        <el-table-column prop="failed" label="失败" width="80" />
        <el-table-column prop="rejected" label="拒绝" width="80" />
        <el-table-column prop="inFlight" label="进行中" width="90" />
        <el-table-column prop="unknown" label="结果未知" width="100" />
        <el-table-column label="异常" min-width="180">
          <template #default="{ row }">
            <el-tag v-if="row.successRateLow" type="danger" size="small">成功率低</el-tag>
            <el-tag v-if="row.rejectRateHigh" type="warning" size="small">拒绝占比高</el-tag>
            <el-tag v-if="row.trafficSpike" type="warning" size="small">流量突增</el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card>
      <template #header>
        <div class="card-header">
          <span>开放调用</span>
          <div class="header-actions">
            <el-button :loading="exporting" @click="handleExportCsv">导出 CSV</el-button>
            <el-button @click="fetchRecords"><el-icon><Refresh /></el-icon></el-button>
          </div>
        </div>
      </template>
      <el-form :inline="true" class="search-form">
        <FilterPanel>
          <template #always>
            <el-form-item label="来源">
              <el-select v-model="filters.source" clearable placeholder="全部" style="width: 120px" @change="handleSearch">
                <el-option label="API" value="API" />
                <el-option label="Webhook" value="WEBHOOK" />
              </el-select>
            </el-form-item>
            <el-form-item label="结果">
              <el-select v-model="filters.outcome" clearable placeholder="全部" style="width: 120px" @change="handleSearch">
                <el-option v-for="item in outcomeOptions" :key="item" :label="outcomeLabel(item)" :value="item" />
              </el-select>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="handleSearch">查询</el-button>
              <el-button @click="handleReset">重置</el-button>
            </el-form-item>
          </template>
          <el-form-item label="用户 ID"><el-input v-model="filters.userId" clearable style="width: 110px" @keyup.enter="handleSearch" /></el-form-item>
          <el-form-item label="Token ID"><el-input v-model="filters.tokenId" clearable style="width: 110px" @keyup.enter="handleSearch" /></el-form-item>
          <el-form-item label="触发器 ID"><el-input v-model="filters.triggerId" clearable style="width: 110px" @keyup.enter="handleSearch" /></el-form-item>
          <el-form-item label="Agent ID"><el-input v-model="filters.agentId" clearable style="width: 110px" @keyup.enter="handleSearch" /></el-form-item>
          <el-form-item label="HTTP"><el-input v-model="filters.httpStatus" clearable style="width: 90px" @keyup.enter="handleSearch" /></el-form-item>
          <el-form-item label="开始"><el-date-picker v-model="filters.startDate" type="date" value-format="YYYY-MM-DD" @change="handleSearch" /></el-form-item>
          <el-form-item label="结束"><el-date-picker v-model="filters.endDate" type="date" value-format="YYYY-MM-DD" @change="handleSearch" /></el-form-item>
        </FilterPanel>
      </el-form>

      <el-table v-if="!isMobile" v-loading="loading" :data="records">
        <el-table-column label="时间" min-width="160"><template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template></el-table-column>
        <el-table-column prop="source" label="来源" width="100" />
        <el-table-column label="Token / 触发器" min-width="140">
          <template #default="{ row }">{{ row.tokenName || row.tokenPrefix || row.triggerName || '-' }}</template>
        </el-table-column>
        <el-table-column label="Agent" min-width="120"><template #default="{ row }">{{ row.agentName || row.agentId || '-' }}</template></el-table-column>
        <el-table-column label="用户" min-width="120"><template #default="{ row }">{{ row.displayName || row.username || row.userId || '-' }}</template></el-table-column>
        <el-table-column prop="sourceIp" label="来源 IP" width="130" />
        <el-table-column prop="httpStatus" label="HTTP" width="80" />
        <el-table-column label="结果" width="100"><template #default="{ row }">{{ outcomeLabel(row.outcome) }}</template></el-table-column>
        <el-table-column label="耗时" width="100"><template #default="{ row }">{{ formatMs(row.executionMs ?? row.durationMs) }}</template></el-table-column>
        <el-table-column prop="errorSummary" label="错误" min-width="160" show-overflow-tooltip />
        <el-table-column label="操作" width="140">
          <template #default="{ row }">
            <el-button link type="primary" @click="showDetail(row)">详情</el-button>
            <el-button v-if="row.sessionId" link type="primary" @click="goSession(row.sessionId)">会话</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div v-else v-loading="loading" class="card-list">
        <el-card v-for="row in records" :key="row.id" class="call-card" shadow="never">
          <div>{{ formatDateTime(row.createdAt) }} · {{ row.source }} · {{ outcomeLabel(row.outcome) }}</div>
          <div>{{ row.displayName || row.username || row.userId || '-' }} · {{ row.errorSummary || '' }}</div>
          <el-button link type="primary" @click="showDetail(row)">详情</el-button>
        </el-card>
        <el-empty v-if="!loading && records.length === 0" description="暂无数据" />
      </div>
      <ResponsivePagination
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[20, 50, 100]"
        @current-change="fetchRecords"
        @size-change="handleSizeChange"
      />
    </el-card>

    <ResponsiveDialog v-model="detailVisible" title="调用详情" width="720px">
      <template v-if="current">
        <el-descriptions :column="isMobile ? 1 : 2" border>
          <el-descriptions-item label="时间">{{ formatDateTime(current.createdAt) }}</el-descriptions-item>
          <el-descriptions-item label="结果">{{ outcomeLabel(current.outcome) }}</el-descriptions-item>
          <el-descriptions-item label="错误" :span="2">{{ current.errorSummary || '-' }}</el-descriptions-item>
        </el-descriptions>
        <h4>脱敏摘要</h4>
        <pre class="json-block">{{ pretty(current.requestSummaryJson) }}</pre>
        <h4>完整请求体</h4>
        <pre class="json-block">{{ current.requestFullJson ? pretty(current.requestFullJson) : '未开启完整记录' }}</pre>
        <el-input v-model="replayMessage" type="textarea" :rows="4" placeholder="重发 message；留空则使用完整记录里的 message" />
        <div class="detail-actions">
          <el-button @click="copyCurl">复制为 cURL</el-button>
          <el-button v-if="canReplay && current.source === 'API'" type="primary" :loading="replaying" @click="doReplay">重发</el-button>
        </div>
      </template>
    </ResponsiveDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { api } from '../../api'
import { downloadBlob } from '../../utils/download'
import { formatDateTime } from '../../utils/datetime'
import { useBreakpoint } from '../../composables/useBreakpoint'
import { useAuthStore } from '../../stores/auth'
import ResponsivePagination from '../../components/ResponsivePagination.vue'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'
import FilterPanel from '../../components/FilterPanel.vue'
import { formatMs } from '../../utils/llmCallLabels'

interface CallRow {
  id: number
  source: string
  tokenId: number | null
  tokenName?: string | null
  tokenPrefix?: string | null
  triggerName?: string | null
  agentId: number | null
  agentName?: string | null
  userId: number | null
  username?: string | null
  displayName?: string | null
  sessionId: number | null
  sourceIp: string | null
  httpStatus: number | null
  outcome: string
  errorSummary: string | null
  durationMs: number | null
  executionMs: number | null
  createdAt: string | null
  requestSummaryJson?: string | null
  requestFullJson?: string | null
}

interface StatsPayload {
  granularity: 'day' | 'token'
  summary: {
    total: number
    completed: number
    failed: number
    successRate: number | null
    p95ExecutionMs: number | null
    p95QueueWaitMs: number | null
    p95Truncated: boolean
  }
  buckets: Array<Record<string, unknown>>
}

const outcomeOptions = ['pending', 'queued', 'rejected', 'completed', 'failed', 'cancelled']
const EXPORT_PAGE_SIZE = 500
const EXPORT_MAX_ROWS = 10000

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const { isMobile } = useBreakpoint()
const canReplay = computed(() => auth.hasPermission('openapi:replay'))
const loading = ref(false)
const exporting = ref(false)
const replaying = ref(false)
const records = ref<CallRow[]>([])
const total = ref(0)
const currentPage = ref(1)
const pageSize = ref(20)
const stats = ref<StatsPayload | null>(null)
const detailVisible = ref(false)
const current = ref<CallRow | null>(null)
const replayMessage = ref('')
const filters = reactive({
  source: '',
  outcome: '',
  userId: '',
  tokenId: '',
  triggerId: '',
  agentId: '',
  httpStatus: '',
  startDate: '',
  endDate: '',
})

const successText = computed(() => {
  const rate = stats.value?.summary.successRate
  return rate == null ? '-' : `${Math.round(rate * 1000) / 10}%`
})

function outcomeLabel(outcome: string): string {
  const labels: Record<string, string> = {
    pending: '处理中', queued: '排队中', rejected: '已拒绝', completed: '成功', failed: '失败', cancelled: '已取消',
  }
  return labels[outcome] ?? outcome
}

function pretty(raw: string | null | undefined): string {
  if (!raw) return '-'
  try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return raw }
}

function optionalId(raw: string): number | undefined {
  if (raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

function buildParams(page: number, size: number): Record<string, unknown> {
  return {
    page, size,
    source: filters.source || undefined,
    outcome: filters.outcome || undefined,
    userId: optionalId(filters.userId),
    tokenId: optionalId(filters.tokenId),
    triggerId: optionalId(filters.triggerId),
    agentId: optionalId(filters.agentId),
    httpStatus: optionalId(filters.httpStatus),
    startDate: filters.startDate || undefined,
    endDate: filters.endDate || undefined,
  }
}

function applyQueryFilters() {
  const q = route.query
  const text = (key: string) => typeof q[key] === 'string' ? q[key] as string : ''
  filters.source = text('source')
  filters.outcome = text('outcome')
  filters.userId = text('userId')
  filters.tokenId = text('tokenId')
  filters.triggerId = text('triggerId')
  filters.agentId = text('agentId')
  filters.httpStatus = text('httpStatus')
  filters.startDate = text('startDate')
  filters.endDate = text('endDate')
}

let fetchSeq = 0
async function loadRecords() {
  const seq = ++fetchSeq
  loading.value = true
  try {
    const params = buildParams(currentPage.value, pageSize.value)
    const [listRes, statsRes] = await Promise.all([
      api.get('/admin/openapi/calls', { params }),
      api.get('/admin/openapi/call-stats', { params: { ...params, granularity: 'day', page: undefined, size: undefined } }),
    ])
    if (seq !== fetchSeq) return
    records.value = listRes.data?.records || []
    total.value = listRes.data?.total || 0
    stats.value = statsRes.data
  } catch { /* 拦截器已提示 */ } finally {
    if (seq === fetchSeq) loading.value = false
  }
}

function fetchRecords() { void loadRecords() }
function handleSearch() {
  currentPage.value = 1
  void router.replace({ query: { ...buildParams(1, pageSize.value) } as Record<string, string> })
  void loadRecords()
}
function handleReset() {
  filters.source = ''
  filters.outcome = ''
  filters.userId = ''
  filters.tokenId = ''
  filters.triggerId = ''
  filters.agentId = ''
  filters.httpStatus = ''
  filters.startDate = ''
  filters.endDate = ''
  handleSearch()
}
function handleSizeChange() {
  currentPage.value = 1
  void loadRecords()
}
function goSession(sessionId: number) {
  void router.push(`/sessions/${sessionId}`)
}

async function showDetail(row: CallRow) {
  detailVisible.value = true
  replayMessage.value = ''
  current.value = row
  try {
    const { data } = await api.get(`/admin/openapi/calls/${row.id}`)
    current.value = data
    const message = messageOf(data?.requestFullJson)
    if (message) replayMessage.value = message
  } catch { /* 列表行仍可看摘要 */ }
}

function messageOf(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { message?: unknown }
    return typeof parsed.message === 'string' ? parsed.message : null
  } catch { return null }
}

function copyCurl() {
  const row = current.value
  if (row == null) return
  const prefix = row.tokenPrefix ? `${row.tokenPrefix}...` : 'mao_<prefix>...'
  const message = replayMessage.value || '<在此粘贴 message>'
  const body = JSON.stringify({ message, sessionId: row.sessionId ?? undefined })
  const command = row.requestFullJson
    ? `curl -X POST '${location.origin}/api/v1/open/agents/${row.agentId}/run' -H 'Authorization: Bearer ${prefix}' -H 'Content-Type: application/json' -d '${body.replace(/'/g, `'\\''`)}'`
    : `curl -X POST '${location.origin}/api/v1/open/agents/${row.agentId}/run' -H 'Authorization: Bearer ${prefix}' -H 'Content-Type: application/json' -d '{"message":"<在此粘贴 message>"}'`
  void navigator.clipboard.writeText(command)
  ElMessage.success('已复制 cURL 模板')
}

async function doReplay() {
  if (current.value == null) return
  replaying.value = true
  try {
    await api.post(`/admin/openapi/calls/${current.value.id}/replay`, { message: replayMessage.value || undefined })
    ElMessage.success('已重发，请在流水中查看新的一行')
    detailVisible.value = false
    void loadRecords()
  } catch { /* 拦截器已提示 */ } finally {
    replaying.value = false
  }
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value)
  return `"${text.replace(/"/g, '""')}"`
}

async function handleExportCsv() {
  if (total.value > EXPORT_MAX_ROWS) {
    ElMessage.warning(`当前筛选共 ${total.value} 条，超出导出上限 ${EXPORT_MAX_ROWS} 条，请缩小筛选范围后重试`)
    return
  }
  exporting.value = true
  try {
    const rows: CallRow[] = []
    let pageNum = 1
    while (rows.length < total.value && rows.length < EXPORT_MAX_ROWS) {
      const { data } = await api.get('/admin/openapi/calls', { params: buildParams(pageNum, EXPORT_PAGE_SIZE) })
      const batch: CallRow[] = data?.records || []
      if (batch.length === 0) break
      rows.push(...batch)
      pageNum += 1
    }
    const header = ['时间', '来源', 'Token', '触发器', 'Agent', '用户', '来源 IP', 'HTTP', '结果', '受理耗时(ms)', '端到端(ms)', '错误摘要', '会话 ID']
    const lines = [header.map(csvCell).join(',')]
    for (const row of rows) {
      lines.push([
        row.createdAt, row.source, row.tokenId ?? '', row.triggerName ?? '', row.agentId ?? '', row.userId ?? '',
        row.sourceIp ?? '', row.httpStatus ?? '', row.outcome, row.durationMs ?? '', row.executionMs ?? '',
        row.errorSummary ?? '', row.sessionId ?? '',
      ].map(csvCell).join(','))
      if ('requestFullJson' in row && row.requestFullJson) {
        throw new Error('导出不应包含完整请求体')
      }
    }
    downloadBlob(new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8;' }), `openapi-calls-${new Date().toISOString().slice(0, 10)}.csv`)
    ElMessage.success(`已导出 ${rows.length} 条`)
  } catch { /* 拦截器已提示 */ } finally {
    exporting.value = false
  }
}

onMounted(() => {
  applyQueryFilters()
  void loadRecords()
})
onActivated(() => {
  applyQueryFilters()
  void loadRecords()
})
</script>

<style scoped>
.summary-row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 12px; }
.summary-item { display: flex; flex-direction: column; min-width: 120px; }
.summary-item span { color: var(--el-text-color-secondary); font-size: 12px; }
.card-header, .header-actions, .detail-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.detail-actions { margin-top: 12px; justify-content: flex-end; }
.json-block { white-space: pre-wrap; word-break: break-all; background: var(--el-fill-color-light); padding: 8px; }
.stats-card { margin-bottom: 12px; }
.hint { color: var(--el-text-color-secondary); font-size: 12px; }
.call-card { margin-bottom: 8px; }
</style>
