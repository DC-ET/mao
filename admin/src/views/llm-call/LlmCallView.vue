<template>
  <div class="llm-call-view">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>调用流水</span>
          <div class="header-actions">
            <el-button :loading="exporting" @click="handleExportCsv">导出 CSV</el-button>
            <el-button @click="fetchRecords">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </div>
        </div>
      </template>

      <el-form :inline="true" class="search-form">
        <FilterPanel>
          <template #always>
            <el-form-item label="场景">
              <el-select v-model="filters.scene" clearable placeholder="全部" style="width: 150px" @change="handleSearch">
                <el-option v-for="opt in LLM_CALL_SCENE_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
              </el-select>
            </el-form-item>
            <el-form-item label="结果">
              <el-select v-model="filters.success" clearable placeholder="全部" style="width: 120px" @change="handleSearch">
                <el-option label="成功" :value="true" />
                <el-option label="失败" :value="false" />
              </el-select>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="handleSearch">查询</el-button>
              <el-button @click="handleReset">重置</el-button>
            </el-form-item>
          </template>
          <el-form-item label="用户">
            <el-select
              v-model="filters.userId"
              clearable
              filterable
              placeholder="全部"
              style="width: 160px"
              @change="handleSearch"
            >
              <el-option
                v-for="u in userOptions"
                :key="u.id"
                :label="u.displayName || u.username || `用户 #${u.id}`"
                :value="u.id"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="Agent">
            <el-select
              v-model="filters.agentId"
              clearable
              filterable
              placeholder="全部 Agent"
              style="width: 160px"
              @change="handleSearch"
            >
              <el-option v-for="a in agentOptions" :key="a.id" :label="a.name" :value="a.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="会话 ID">
            <el-input v-model="filters.sessionId" clearable placeholder="会话 ID" style="width: 120px" @keyup.enter="handleSearch" @clear="handleSearch" />
          </el-form-item>
          <el-form-item label="模型">
            <el-select
              v-model="filters.modelId"
              clearable
              filterable
              remote
              :remote-method="searchModels"
              :loading="modelSearching"
              placeholder="全部"
              style="width: 180px"
              @change="handleSearch"
            >
              <el-option
                v-for="m in modelOptions"
                :key="m.id"
                :label="m.provider ? `${m.name} (${m.provider})` : m.name"
                :value="m.id"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="开始日期">
            <el-date-picker v-model="filters.startDate" type="date" value-format="YYYY-MM-DD" placeholder="开始" style="width: 150px" @change="handleSearch" />
          </el-form-item>
          <el-form-item label="结束日期">
            <el-date-picker v-model="filters.endDate" type="date" value-format="YYYY-MM-DD" placeholder="结束" style="width: 150px" @change="handleSearch" />
          </el-form-item>
        </FilterPanel>
      </el-form>

      <el-table v-if="!isMobile" :data="records" v-loading="loading" stripe>
        <template #empty>
          <el-empty description="暂无数据" :image-size="60" />
        </template>
        <el-table-column prop="createdAt" label="时间" width="170" :formatter="formatDateTimeColumn" />
        <el-table-column label="用户" width="120" show-overflow-tooltip>
          <template #default="{ row }">{{ row.displayName || row.username || row.userId || '-' }}</template>
        </el-table-column>
        <el-table-column label="场景" width="120">
          <template #default="{ row }">
            <el-tag size="small">{{ llmCallSceneLabel(row.scene) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="模型" width="180" show-overflow-tooltip>
          <template #default="{ row }">{{ row.modelName || row.providerModelId || '-' }}</template>
        </el-table-column>
        <el-table-column label="入 Token" width="100" align="right">
          <template #default="{ row }">{{ formatNumber(row.promptTokens || 0) }}</template>
        </el-table-column>
        <el-table-column label="出 Token" width="100" align="right">
          <template #default="{ row }">{{ formatNumber(row.completionTokens || 0) }}</template>
        </el-table-column>
        <el-table-column label="缓存" width="140" align="right" class-name="hide-on-mobile cache-col">
          <template #default="{ row }">
            <span class="cache-cell">{{ formatCacheHit(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="流式" width="70" align="center">
          <template #default="{ row }">{{ row.stream === 1 ? '是' : '否' }}</template>
        </el-table-column>
        <el-table-column label="首字" width="90" align="right">
          <template #default="{ row }">{{ formatMs(row.firstTokenMs) }}</template>
        </el-table-column>
        <el-table-column label="总耗时" width="90" align="right">
          <template #default="{ row }">{{ formatMs(row.durationMs) }}</template>
        </el-table-column>
        <el-table-column label="结果" width="80">
          <template #default="{ row }">
            <el-tag size="small" :type="row.success === 1 ? 'success' : 'danger'">
              {{ row.success === 1 ? '成功' : '失败' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="showDetail(row)">详情</el-button>
            <el-button v-if="row.sessionId" type="primary" link size="small" @click="goSession(row.sessionId)">
              查看会话
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-else class="mobile-card-list">
        <el-card v-for="row in records" :key="row.id" class="call-card" shadow="hover">
          <div class="call-card-head">
            <el-tag size="small">{{ llmCallSceneLabel(row.scene) }}</el-tag>
            <el-tag size="small" :type="row.success === 1 ? 'success' : 'danger'">
              {{ row.success === 1 ? '成功' : '失败' }}
            </el-tag>
          </div>
          <div class="call-card-row"><span class="call-card-label">时间</span><span>{{ formatDateTime(row.createdAt) }}</span></div>
          <div class="call-card-row"><span class="call-card-label">用户</span><span>{{ row.displayName || row.username || row.userId || '-' }}</span></div>
          <div class="call-card-row"><span class="call-card-label">模型</span><span>{{ row.modelName || '-' }}</span></div>
          <div class="call-card-row"><span class="call-card-label">Token</span><span>{{ formatNumber(row.promptTokens || 0) }} / {{ formatNumber(row.completionTokens || 0) }}</span></div>
          <div class="call-card-row"><span class="call-card-label">缓存</span><span>{{ formatCacheHit(row) }}</span></div>
          <div class="call-card-row"><span class="call-card-label">耗时</span><span>首字 {{ formatMs(row.firstTokenMs) }} / 总 {{ formatMs(row.durationMs) }}</span></div>
          <div class="call-card-row"><span class="call-card-label">重试</span><span>{{ row.retryCount ?? 0 }}</span></div>
          <div v-if="row.errorMessage" class="call-card-row"><span class="call-card-label">错误</span><span class="call-card-error">{{ row.errorMessage }}</span></div>
          <div class="call-card-actions">
            <el-button type="primary" link size="small" @click="showDetail(row)">详情</el-button>
            <el-button v-if="row.sessionId" type="primary" link size="small" @click="goSession(row.sessionId)">
              查看会话
            </el-button>
          </div>
        </el-card>
        <el-empty v-if="!loading && records.length === 0" description="暂无数据" />
      </div>

      <ResponsivePagination
        class="pagination"
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[20, 50, 100]"
        @current-change="fetchRecords"
        @size-change="handleSizeChange"
      />
    </el-card>

    <ResponsiveDialog v-if="detailVisible" v-model="detailVisible" title="调用详情" width="720px">
      <el-descriptions v-if="currentRecord" :column="2" border>
        <el-descriptions-item label="时间">{{ formatDateTime(currentRecord.createdAt) }}</el-descriptions-item>
        <el-descriptions-item label="结果">{{ currentRecord.success === 1 ? '成功' : '失败' }}</el-descriptions-item>
        <el-descriptions-item label="用户">{{ currentRecord.displayName || currentRecord.username || currentRecord.userId || '-' }}</el-descriptions-item>
        <el-descriptions-item label="场景">{{ llmCallSceneLabel(currentRecord.scene) }}</el-descriptions-item>
        <el-descriptions-item label="会话 ID">{{ currentRecord.sessionId || '-' }}</el-descriptions-item>
        <el-descriptions-item label="Agent">{{ currentRecord.agentName || currentRecord.agentId || '-' }}</el-descriptions-item>
        <el-descriptions-item label="模型">{{ currentRecord.modelName || '-' }}</el-descriptions-item>
        <el-descriptions-item label="供应商">{{ currentRecord.provider || '-' }}</el-descriptions-item>
        <el-descriptions-item label="上游模型 ID" :span="2">{{ currentRecord.providerModelId || '-' }}</el-descriptions-item>
        <el-descriptions-item label="协议">{{ currentRecord.protocol || '-' }}</el-descriptions-item>
        <el-descriptions-item label="推理强度">{{ currentRecord.effort || '-' }}</el-descriptions-item>
        <el-descriptions-item label="流式">{{ currentRecord.stream === 1 ? '是' : '否' }}</el-descriptions-item>
        <el-descriptions-item label="重试">{{ currentRecord.retryCount ?? 0 }}</el-descriptions-item>
        <el-descriptions-item label="入 Token">{{ formatNumber(currentRecord.promptTokens || 0) }}</el-descriptions-item>
        <el-descriptions-item label="出 Token">{{ formatNumber(currentRecord.completionTokens || 0) }}</el-descriptions-item>
        <el-descriptions-item label="缓存 Token">{{ formatCacheHit(currentRecord) }}</el-descriptions-item>
        <el-descriptions-item label="合计 Token">{{ formatNumber(currentRecord.totalTokens || 0) }}</el-descriptions-item>
        <el-descriptions-item label="首字耗时">{{ formatMs(currentRecord.firstTokenMs) }}</el-descriptions-item>
        <el-descriptions-item label="总耗时">{{ formatMs(currentRecord.durationMs) }}</el-descriptions-item>
        <el-descriptions-item label="错误" :span="2">{{ currentRecord.errorMessage || '-' }}</el-descriptions-item>
      </el-descriptions>
    </ResponsiveDialog>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, onMounted, onActivated } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { api } from '../../api'
import { formatDateTime, formatDateTimeColumn } from '../../utils/datetime'
import { useBreakpoint } from '../../composables/useBreakpoint'
import ResponsivePagination from '../../components/ResponsivePagination.vue'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'
import FilterPanel from '../../components/FilterPanel.vue'
import { LLM_CALL_SCENE_OPTIONS, llmCallSceneLabel, formatMs } from '../../utils/llmCallLabels'

const route = useRoute()
const router = useRouter()
const { isMobile } = useBreakpoint()
const loading = ref(false)
const exporting = ref(false)
const records = ref<any[]>([])
const total = ref(0)
const currentPage = ref(1)
const pageSize = ref(20)
const detailVisible = ref(false)
const currentRecord = ref<any | null>(null)
const userOptions = ref<Array<{ id: number; username?: string | null; displayName?: string | null }>>([])
const agentOptions = ref<Array<{ id: number; name: string }>>([])
const modelOptions = ref<Array<{ id: number; name: string; provider?: string | null }>>([])
const modelSearching = ref(false)
const EXPORT_PAGE_SIZE = 500
const EXPORT_MAX_ROWS = 10000
const filters = reactive({
  scene: '',
  success: undefined as boolean | undefined,
  userId: undefined as number | undefined,
  agentId: undefined as number | string | undefined,
  sessionId: '',
  modelId: undefined as number | undefined,
  startDate: '',
  endDate: '',
})

function applyQueryFilters() {
  const q = route.query
  if (typeof q.scene === 'string' && q.scene) filters.scene = q.scene
  if (q.success === 'false' || q.success === '0') filters.success = false
  if (q.success === 'true' || q.success === '1') filters.success = true
  const userId = Number(q.userId)
  if (q.userId != null && q.userId !== '' && Number.isFinite(userId)) filters.userId = userId
  const agentId = Number(q.agentId)
  if (q.agentId != null && q.agentId !== '' && Number.isFinite(agentId)) filters.agentId = agentId
  if (typeof q.sessionId === 'string' && q.sessionId) filters.sessionId = q.sessionId
  const modelId = Number(q.modelId)
  if (q.modelId != null && q.modelId !== '' && Number.isFinite(modelId)) filters.modelId = modelId
  if (typeof q.startDate === 'string' && q.startDate) filters.startDate = q.startDate
  if (typeof q.endDate === 'string' && q.endDate) filters.endDate = q.endDate
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function formatCacheHit(row: { cachedTokens?: number | null; promptTokens?: number | null }) {
  const cached = row.cachedTokens || 0
  const prompt = row.promptTokens || 0
  if (cached <= 0) return '0'
  const num = formatNumber(cached)
  if (prompt <= 0) return num
  return `${num} (${Math.round((cached / prompt) * 100)}%)`
}

function buildFilterParams(page: number, size: number): Record<string, unknown> {
  const params: Record<string, unknown> = { page, size }
  if (filters.scene) params.scene = filters.scene
  if (filters.success !== undefined) params.success = filters.success
  if (filters.userId != null) params.userId = filters.userId
  if (filters.agentId != null && filters.agentId !== '') {
    const agentId = Number(filters.agentId)
    if (Number.isFinite(agentId)) params.agentId = agentId
  }
  if (filters.sessionId) {
    const sessionId = Number(filters.sessionId)
    if (Number.isFinite(sessionId)) params.sessionId = sessionId
  }
  if (filters.modelId != null) params.modelId = filters.modelId
  if (filters.startDate) params.startDate = filters.startDate
  if (filters.endDate) params.endDate = filters.endDate
  return params
}

let fetchSeq = 0
async function fetchRecords() {
  const seq = ++fetchSeq
  loading.value = true
  try {
    const { data } = await api.get('/admin/llm-calls', {
      params: buildFilterParams(currentPage.value, pageSize.value)
    })
    if (seq !== fetchSeq) return
    records.value = data?.records || []
    total.value = data?.total || 0
  } catch { /* handled */ } finally {
    if (seq === fetchSeq) loading.value = false
  }
}

function handleSearch() {
  currentPage.value = 1
  fetchRecords()
}

function handleReset() {
  filters.scene = ''
  filters.success = undefined
  filters.userId = undefined
  filters.agentId = undefined
  filters.sessionId = ''
  filters.modelId = undefined
  filters.startDate = ''
  filters.endDate = ''
  handleSearch()
}

function handleSizeChange() {
  currentPage.value = 1
  fetchRecords()
}

function goSession(sessionId: number | string) {
  router.push(`/sessions/${sessionId}`)
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value)
  return `"${text.replace(/"/g, '""')}"`
}

function handleExportCsv() {
  if (total.value > EXPORT_MAX_ROWS) {
    ElMessage.warning(`当前筛选共 ${total.value} 条，超出导出上限 ${EXPORT_MAX_ROWS} 条，请缩小筛选范围后重试`)
    return
  }
  doExportCsv()
}

async function doExportCsv() {
  exporting.value = true
  try {
    const rows: any[] = []
    let pageNum = 1
    while (rows.length < total.value && rows.length < EXPORT_MAX_ROWS) {
      const { data } = await api.get('/admin/llm-calls', {
        params: buildFilterParams(pageNum, EXPORT_PAGE_SIZE)
      })
      const records: any[] = data?.records || []
      if (records.length === 0) break
      rows.push(...records)
      pageNum += 1
    }
    const header = ['时间', '用户', '模型', '输入 Token', '输出 Token', '耗时(ms)', '缓存 Token', '状态', '错误信息', '会话 ID', 'Agent ID']
    const lines = [header.map(csvCell).join(',')]
    for (const row of rows) {
      lines.push([
        row.createdAt,
        row.displayName || row.username || row.userId || '',
        row.modelName || row.providerModelId || '',
        row.promptTokens || 0,
        row.completionTokens || 0,
        row.durationMs ?? '',
        row.cachedTokens || 0,
        row.success === 1 ? '成功' : '失败',
        row.errorMessage || '',
        row.sessionId ?? '',
        row.agentId ?? ''
      ].map(csvCell).join(','))
    }
    const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `llm-calls-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  } catch { /* 拦截器已提示失败 */ } finally {
    exporting.value = false
  }
}

async function searchModels(keyword: string) {
  modelSearching.value = true
  try {
    const { data } = await api.get('/models', { params: { page: 1, size: 50, keyword: keyword || undefined } })
    modelOptions.value = data?.records || []
  } catch { /* 拦截器已提示失败 */ } finally {
    modelSearching.value = false
  }
}

function showDetail(row: any) {
  currentRecord.value = row
  detailVisible.value = true
}

async function fetchFilterOptions() {
  try {
    const [usersRes, agentsRes, modelsRes] = await Promise.all([
      api.get('/admin/sessions/options/users'),
      api.get('/admin/sessions/options/agents'),
      api.get('/models', { params: { page: 1, size: 50 } }),
    ])
    userOptions.value = usersRes.data || []
    agentOptions.value = agentsRes.data || []
    modelOptions.value = modelsRes.data?.records || []
  } catch { /* 拦截器已提示失败 */ }
}

onMounted(() => {
  applyQueryFilters()
  fetchRecords()
  fetchFilterOptions()
})

// 本页 keepAlive: true，切走再回来不会重跑 onMounted。调用流水是持续增长的实时流水表，
// 沿用缓存视图会让人误判「最近没有调用」，因此激活时按当前 URL 筛选重新拉取。
// 首次挂载时 activated 紧随 mounted 触发，必须跳过，否则首屏请求两次。
let firstActivation = true
onActivated(() => {
  if (firstActivation) {
    firstActivation = false
    return
  }
  applyQueryFilters()
  fetchRecords()
})
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.search-form {
  margin-bottom: 16px;
}

.pagination {
  margin-top: 16px;
  justify-content: flex-end;
}

.cache-col .cache-cell {
  white-space: nowrap;
}

.mobile-card-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.call-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.call-card-row {
  display: flex;
  gap: 8px;
  padding: 4px 0;
  line-height: 1.5;
}

.call-card-label {
  width: 48px;
  flex-shrink: 0;
  color: var(--mao-muted);
}

.call-card-error {
  color: var(--el-color-danger);
  word-break: break-all;
}

.call-card-actions {
  margin-top: 10px;
  border-top: 1px solid var(--mao-border);
  padding-top: 10px;
}
</style>
