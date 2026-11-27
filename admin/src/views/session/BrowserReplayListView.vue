<template>
  <div class="browser-replay-list">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>浏览器回放</span>
        </div>
      </template>

      <!-- 顶部固定提示：跨用户查看高敏 + LOCAL 录制不可见（§5.2 / §7） -->
      <el-alert
        :title="BROWSER_REPLAY_SENSITIVE_NOTICE"
        type="warning"
        :closable="false"
        show-icon
        class="notice-banner"
      />

      <!-- 候选/manifest 读取超上限：不静默截断，提示缩小范围（§4.3） -->
      <el-alert
        v-if="truncatedTip"
        :title="truncatedTip"
        type="warning"
        :closable="false"
        show-icon
        class="truncated-banner"
      />

      <!-- 错误态：列表接口失败，保留筛选条件一键重试 -->
      <el-alert v-if="loadError" type="error" :closable="false" show-icon class="error-banner" title="回放列表加载失败">
        <div class="error-banner-body">
          <span>加载回放列表失败，筛选条件已保留。</span>
          <el-button size="small" type="primary" :loading="loading" @click="fetchReplays">重试</el-button>
        </div>
      </el-alert>

      <!-- Filter form -->
      <el-form :inline="true" class="search-form">
        <FilterPanel>
          <template #always>
            <el-form-item label="关键词">
              <el-input
                v-model="filters.keyword"
                placeholder="会话标题"
                clearable
                style="width: 200px"
                @keyup.enter="handleSearch"
                @clear="handleSearch"
              />
            </el-form-item>
            <el-form-item label="录制时间">
              <el-select v-model="filters.activityRange" style="width: 120px">
                <el-option
                  v-for="opt in ACTIVITY_RANGE_OPTIONS"
                  :key="opt.value"
                  :label="opt.label"
                  :value="opt.value"
                />
              </el-select>
              <el-date-picker
                v-if="filters.activityRange === 'CUSTOM'"
                v-model="filters.activityCustomRange"
                type="daterange"
                value-format="YYYY-MM-DD"
                range-separator="至"
                start-placeholder="开始日期"
                end-placeholder="结束日期"
                style="width: 250px; margin-left: 8px"
              />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="handleSearch">查询</el-button>
              <el-button @click="handleReset">重置</el-button>
            </el-form-item>
          </template>
          <el-form-item label="用户">
            <el-select v-model="filters.userId" placeholder="全部用户" clearable filterable style="width: 160px">
              <el-option v-for="u in userOptions" :key="u.id" :label="u.displayName || u.username" :value="u.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="Agent">
            <el-select v-model="filters.agentId" placeholder="全部 Agent" clearable filterable style="width: 160px">
              <el-option v-for="a in agentOptions" :key="a.id" :label="a.name" :value="a.id" />
            </el-select>
          </el-form-item>
          <!-- 会话详情页深链 ?sessionId=：可见可清除，避免管理员不知道列表被过滤了（§5.4） -->
          <el-form-item v-if="filters.sessionId != null" label="会话">
            <el-tag closable @close="clearSessionFilter">仅看会话 #{{ filters.sessionId }}</el-tag>
          </el-form-item>
        </FilterPanel>
      </el-form>

      <!-- Table -->
      <el-table v-if="!isMobile" :data="records" stripe v-loading="loading">
        <template #empty>
          <div class="replay-empty">
            <p class="replay-empty-title">暂无回放</p>
            <p class="replay-empty-hint">{{ emptyHint }}</p>
          </div>
        </template>
        <el-table-column label="开始时间" width="180">
          <template #default="{ row }">{{ formatReplayTime(row.startedAt) }}</template>
        </el-table-column>
        <el-table-column label="用户" width="120" show-overflow-tooltip>
          <template #default="{ row }">{{ row.username || `#${row.userId ?? '-'}` }}</template>
        </el-table-column>
        <el-table-column prop="agentName" label="Agent" width="120" show-overflow-tooltip />
        <el-table-column label="会话标题" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">
            <el-button link type="primary" :title="replaySessionTitle(row)" @click="goSession(row)">
              {{ replaySessionTitle(row) }}
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="时长" width="110">
          <template #default="{ row }">{{ formatDuration(row.durationMs) }}</template>
        </el-table-column>
        <el-table-column prop="frameCount" label="帧数" width="80" align="right" />
        <el-table-column label="体积" width="100" align="right">
          <template #default="{ row }">{{ formatBytes(row.approxBytes) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="150">
          <template #default="{ row }">
            <el-tag
              v-for="tag in replayStatusTags(row)"
              :key="tag.label"
              :type="tag.type"
              size="small"
              style="margin-right: 4px"
            >
              {{ tag.label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="110" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="openPlayer(row)">查看回放</el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- Mobile card list -->
      <div v-else class="mobile-card-list">
        <el-card v-for="row in records" :key="`${row.sessionId}:${row.liveId}`" shadow="hover">
          <div class="mobile-card-head">
            <span class="mobile-card-title">{{ replaySessionTitle(row) }}</span>
            <el-tag
              v-for="tag in replayStatusTags(row)"
              :key="tag.label"
              :type="tag.type"
              size="small"
            >
              {{ tag.label }}
            </el-tag>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">开始</span>
            <span>{{ formatReplayTime(row.startedAt) }}</span>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">用户</span>
            <span>{{ row.username || `#${row.userId ?? '-'}` }}</span>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">Agent</span>
            <span>{{ row.agentName || '-' }}</span>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">时长</span>
            <span>{{ formatDuration(row.durationMs) }} · {{ row.frameCount }} 帧 · {{ formatBytes(row.approxBytes) }}</span>
          </div>
          <div class="mobile-card-actions">
            <el-button type="primary" link size="small" @click="goSession(row)">打开会话</el-button>
            <el-button type="primary" link size="small" @click="openPlayer(row)">查看回放</el-button>
          </div>
        </el-card>
        <div v-if="!loading && records.length === 0" class="replay-empty">
          <p class="replay-empty-title">暂无回放</p>
          <p class="replay-empty-hint">{{ emptyHint }}</p>
        </div>
      </div>

      <!-- Pagination -->
      <ResponsivePagination
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[20, 50, 100]"
        style="margin-top: 16px; justify-content: flex-end"
        @current-change="fetchReplays"
        @size-change="handleSizeChange"
      />
    </el-card>

    <!-- 播放抽屉：数据仅走 admin timeline / frames 端点，LOCAL 会话后端直接拒答 -->
    <el-drawer
      v-model="playerVisible"
      :title="playerTitle"
      :size="isMobile ? '100%' : '860px'"
      destroy-on-close
      append-to-body
    >
      <BrowserReplayPlayer
        v-if="player"
        :session-id="player.sessionId"
        :live-id="player.liveId"
        @close="playerVisible = false"
      />
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
/**
 * 跨会话「浏览器回放」列表（技术方案 2026-11-27 §5.2）：全局跨用户列出 CLOUD 录制，
 * 筛选 / 分页 / 深链口径照抄 SessionListView；播放走抽屉里的 BrowserReplayPlayer。
 * 取数内联在视图（admin 惯例，无按域 api 模块）；纯逻辑在同目录 browserReplayFormat.ts。
 */
import { computed, onActivated, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { BrowserReplayListItem, BrowserReplayListResult } from '@mao/contracts'
import { api } from '../../api'
import FilterPanel from '../../components/FilterPanel.vue'
import ResponsivePagination from '../../components/ResponsivePagination.vue'
import BrowserReplayPlayer from '../../components/browser/BrowserReplayPlayer.vue'
import { useBreakpoint } from '../../composables/useBreakpoint'
import {
  ACTIVITY_RANGE_DEFAULT,
  ACTIVITY_RANGE_OPTIONS,
  defaultCustomRange,
  isActivityRangeValue
} from '../../utils/sessionActivityRange'
import {
  BROWSER_REPLAY_SENSITIVE_NOTICE,
  BROWSER_REPLAY_TTL_DAYS_DEFAULT,
  browserReplayEmptyHint,
  browserReplayTruncatedTip,
  formatBytes,
  formatDuration,
  formatReplayTime,
  replayListParams,
  replaySessionTitle,
  replayStatusTags,
  type BrowserReplayFilters
} from './browserReplayFormat'

const route = useRoute()
const router = useRouter()
const { isMobile } = useBreakpoint()
const loading = ref(false)
const loadError = ref(false)
const records = ref<BrowserReplayListItem[]>([])
const currentPage = ref(1)
const pageSize = ref(20)
const total = ref(0)
const truncatedCandidates = ref(false)

const filters = reactive<BrowserReplayFilters>({
  userId: null,
  agentId: null,
  sessionId: null,
  keyword: '',
  // 「录制时间」筛选：默认最近 7 天（后端同口径兜底），ALL = 全部时间
  activityRange: ACTIVITY_RANGE_DEFAULT as string,
  activityCustomRange: null
})

// 切到「自定义」时给一个最近 7 天的初始区间，避免空区间悄悄落回默认档
watch(() => filters.activityRange, (next) => {
  if (next === 'CUSTOM' && !filters.activityCustomRange) {
    filters.activityCustomRange = defaultCustomRange()
  }
})

const userOptions = ref<Array<{ id: number; username: string; displayName: string }>>([])
const agentOptions = ref<Array<{ id: number; name: string }>>([])

const emptyHint = browserReplayEmptyHint(BROWSER_REPLAY_TTL_DAYS_DEFAULT)
const truncatedTip = computed(() => browserReplayTruncatedTip(truncatedCandidates.value))

function applyRouteQuery() {
  const q = route.query
  filters.userId = typeof q.userId === 'string' && q.userId ? Number(q.userId) : null
  filters.agentId = typeof q.agentId === 'string' && q.agentId ? Number(q.agentId) : null
  // 会话详情页深链：仅看某个会话的录制（§5.4）
  filters.sessionId = typeof q.sessionId === 'string' && q.sessionId ? Number(q.sessionId) : null
  filters.keyword = typeof q.keyword === 'string' ? q.keyword : ''
  // 非法值回落到默认口径，避免地址栏拼错就查不到东西
  const range = typeof q.range === 'string' ? q.range.toUpperCase() : ''
  filters.activityRange = isActivityRangeValue(range) ? range : ACTIVITY_RANGE_DEFAULT
  const dateFrom = typeof q.dateFrom === 'string' ? q.dateFrom : ''
  const dateTo = typeof q.dateTo === 'string' ? q.dateTo : ''
  filters.activityCustomRange = dateFrom && dateTo ? [dateFrom, dateTo] : null
  if (filters.activityRange === 'CUSTOM' && !filters.activityCustomRange) {
    filters.activityRange = ACTIVITY_RANGE_DEFAULT
  }
}

/** 上次已经写进筛选表单的 query。地址没变时只刷新列表，不冲掉表单里尚未写入 URL 的条件。 */
let appliedQuery = ''

function syncRouteAndFetch() {
  if (route.name !== 'BrowserReplays') return
  const next = JSON.stringify(route.query)
  if (next !== appliedQuery) {
    appliedQuery = next
    applyRouteQuery()
    currentPage.value = 1
  }
  fetchReplays()
}

let fetchReplaysSeq = 0
async function fetchReplays() {
  const seq = ++fetchReplaysSeq
  loading.value = true
  try {
    const params = replayListParams(filters, currentPage.value, pageSize.value)
    const { data } = await api.get<BrowserReplayListResult>('/admin/browser-replays', { params })
    if (seq !== fetchReplaysSeq) return
    records.value = data?.records || []
    total.value = data?.total || 0
    truncatedCandidates.value = data?.truncatedCandidates === true
    loadError.value = false
  } catch {
    // 拦截器已提示失败；页面侧置错误态供重试（保留筛选条件）
    if (seq !== fetchReplaysSeq) return
    records.value = []
    total.value = 0
    truncatedCandidates.value = false
    loadError.value = true
  } finally {
    if (seq === fetchReplaysSeq) loading.value = false
  }
}

async function fetchOptions() {
  // allSettled：任一接口失败只置空对应下拉（拦截器已提示），
  // 不再连带两个下拉同时为空，也不会抛 unhandled rejection
  const [usersRes, agentsRes] = await Promise.allSettled([
    api.get('/admin/sessions/options/users'),
    api.get('/admin/sessions/options/agents')
  ])
  userOptions.value = usersRes.status === 'fulfilled' ? usersRes.value.data || [] : []
  agentOptions.value = agentsRes.status === 'fulfilled' ? agentsRes.value.data || [] : []
}

function handleSearch() {
  currentPage.value = 1
  fetchReplays()
}

function handleReset() {
  filters.userId = null
  filters.agentId = null
  filters.sessionId = null
  filters.keyword = ''
  filters.activityRange = ACTIVITY_RANGE_DEFAULT
  filters.activityCustomRange = null
  currentPage.value = 1
  fetchReplays()
}

function clearSessionFilter() {
  filters.sessionId = null
  currentPage.value = 1
  fetchReplays()
}

function handleSizeChange() {
  currentPage.value = 1
  fetchReplays()
}

function goSession(row: BrowserReplayListItem) {
  router.push(`/sessions/${row.sessionId}`)
}

// ---------- 播放抽屉 ----------
const player = ref<BrowserReplayListItem | null>(null)
const playerVisible = ref(false)

function openPlayer(row: BrowserReplayListItem) {
  player.value = row
  playerVisible.value = true
}

const playerTitle = computed(() => {
  const row = player.value
  if (!row) return '浏览器回放'
  return `浏览器回放 · 会话 #${row.sessionId} · ${row.liveId}`
})

onMounted(() => {
  appliedQuery = JSON.stringify(route.query)
  applyRouteQuery()
  fetchReplays()
  fetchOptions()
})

// 组件被 keep-alive 缓存时，query 变化不会重建页面。
// 只在本页地址上同步，避免切到详情时把筛选清掉。
watch(() => route.fullPath, () => {
  syncRouteAndFetch()
})

// 从会话详情返回（keep-alive）时刷新列表，保留筛选与页码。
// 首次挂载时 onMounted 与 onActivated 都会触发，跳过首次避免重复请求。
let activatedOnce = false
onActivated(() => {
  if (!activatedOnce) {
    activatedOnce = true
    return
  }
  syncRouteAndFetch()
})
</script>

<style scoped>
.browser-replay-list {
  width: 100%;
}

.card-header {
  font-size: 16px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.notice-banner {
  margin-bottom: 12px;
}

.truncated-banner {
  margin-bottom: 12px;
}

.error-banner {
  margin-bottom: 12px;
}

.error-banner-body {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
}

.search-form {
  margin-bottom: 16px;
}

.search-form .el-form-item {
  margin-bottom: 12px;
}

.replay-empty {
  padding: 24px 12px;
  text-align: center;
}

.replay-empty-title {
  margin: 0 0 6px;
  font-size: 14px;
  color: var(--el-text-color-regular);
}

.replay-empty-hint {
  margin: 0 auto;
  max-width: 560px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
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
  gap: 8px;
}

.mobile-card-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-card-row {
  display: flex;
  gap: 8px;
  margin-top: 6px;
  font-size: 13px;
}

.mobile-card-label {
  flex: none;
  color: var(--el-text-color-secondary);
}

.mobile-card-actions {
  margin-top: 8px;
}

@media (max-width: 768px) {
  .search-form {
    margin-bottom: 8px;
  }
}
</style>
