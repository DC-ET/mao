<template>
  <div class="browser-replays-page">
    <div class="page-header">
      <h1 class="page-title">浏览器回放</h1>
      <p class="page-desc">
        这里汇总你所有会话的浏览器操作录制，点「播放」即可回看整场操作过程。录制内容可能包含登录态页面等敏感信息，请谨慎分享屏幕。
      </p>
    </div>

    <el-alert
      :title="localAvailable
        ? '云端录制存在服务器上；本机（LOCAL）录制保存在这台设备的 ~/.mao/runtime 下，只在这台设备可见，换设备或卸载后不可见。'
        : '当前客户端只能查看云端（CLOUD）录制；LOCAL 录制保存在执行设备本地，服务端不可见。'"
      type="info"
      :closable="false"
      show-icon
      class="source-alert"
    />

    <section class="card">
      <div class="filter-bar">
        <el-select v-model="range" class="filter-range">
          <el-option
            v-for="option in BROWSER_REPLAY_RANGE_OPTIONS"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </el-select>
        <el-date-picker
          v-if="range === 'CUSTOM'"
          v-model="customRange"
          class="filter-range"
          type="daterange"
          value-format="YYYY-MM-DD"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          :clearable="false"
          unlink-panels
        />
        <el-select v-model="mode" class="filter-mode">
          <el-option
            v-for="option in modeOptions"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </el-select>
        <el-input
          v-model="keyword"
          class="filter-keyword"
          placeholder="搜索会话标题"
          clearable
          :maxlength="64"
        />
        <button type="button" class="refresh-btn" @click="loadAll(true)">
          <el-icon :size="13"><Refresh /></el-icon> 刷新
        </button>
      </div>

      <el-alert
        v-if="cloudTotal > CLOUD_FETCH_SIZE"
        type="warning"
        :closable="false"
        show-icon
        class="list-alert"
        :title="`云端录制共 ${cloudTotal} 场，仅展示较新的 ${CLOUD_FETCH_SIZE} 场，请缩小时间范围查看更早的录制`"
      />
      <el-alert
        v-if="truncatedCandidates"
        type="warning"
        :closable="false"
        show-icon
        class="list-alert"
        title="候选数据量过大已被截断，结果可能不完整，请缩小时间范围"
      />
      <el-alert
        v-if="localTruncated"
        type="warning"
        :closable="false"
        show-icon
        class="list-alert"
        title="本机录制数量达到扫描上限，结果可能不完整，请缩小时间范围"
      />
      <el-alert
        v-if="loadError"
        type="error"
        :closable="false"
        show-icon
        class="list-alert"
        :title="loadError"
      >
        <button type="button" class="retry-btn" @click="loadAll()">重试</button>
      </el-alert>

      <div v-if="loading" class="empty-state">加载中…</div>
      <div v-else-if="rows.length === 0" class="empty-state">
        <p class="empty-main">暂无回放记录</p>
        <p class="empty-sub">
          管理员在「系统设置 → 浏览器直播 → 启用操作录制」开启后，此后的浏览器操作会自动录制；
          录制按保留天数定期清理，过期或手动删除的录制不会出现在这里。
        </p>
        <p v-if="localAvailable" class="empty-sub">本机（LOCAL）录制只在这台设备可见。</p>
      </div>
      <div v-else-if="filtered.length === 0" class="empty-state">没有符合筛选条件的回放</div>
      <template v-else>
        <div class="item-list">
          <div v-for="row in pagedRows" :key="rowKey(row)" class="item-card">
            <div class="item-row">
              <div class="item-title">
                <span class="session-title" :title="replayRowTitle(row)">{{ replayRowTitle(row) }}</span>
                <span class="badge" :class="row.executionMode === 'LOCAL' ? 'badge-local' : 'badge-cloud'">
                  {{ row.executionMode }}
                </span>
                <span v-if="row.endedAt == null" class="badge badge-warn">{{ REPLAY_BADGE_UNSETTLED }}</span>
                <span v-if="row.truncated" class="badge badge-danger">{{ REPLAY_BADGE_TRUNCATED }}</span>
              </div>
              <div class="item-actions">
                <button type="button" class="text-btn" @click="openPlay(row)">播放</button>
                <button type="button" class="text-btn" @click="openSession(row.sessionId)">打开会话</button>
              </div>
            </div>
            <div class="item-meta">
              <span>{{ formatDateTime(row.startedAt) }}</span>
              <span>{{ formatReplayDuration(row.durationMs) }}</span>
              <span>{{ row.frameCount }} 帧 · {{ formatReplayBytes(row.approxBytes) }}</span>
              <span v-if="row.agentName">Agent：{{ row.agentName }}</span>
              <span v-if="row.pageUrl" class="url-text" :title="row.pageUrl">{{ row.pageUrl }}</span>
            </div>
          </div>
        </div>
        <div class="pager">
          <el-pagination
            :current-page="page"
            :page-size="PAGE_SIZE"
            :total="filtered.length"
            layout="prev, pager, next"
            small
            @current-change="(value: number) => { page = value }"
          />
        </div>
      </template>
    </section>

    <!--
      播放弹窗（技术方案 2026-11-27 §6.4）：桌面用 ≥720px 弹窗，安卓 / 窄屏用全屏抽屉
      （el-dialog fullscreen 即覆盖视口的全屏形态）。内容复用直播 Tab 的播放器组件。
    -->
    <el-dialog
      v-model="playVisible"
      :title="playTitle"
      width="min(860px, calc(100vw - 32px))"
      top="6vh"
      class="replay-dialog"
      :fullscreen="isMobileViewport"
      @closed="playingItem = null"
    >
      <div class="replay-stage-wrap">
        <BrowserReplayPlayer
          v-if="playingItem"
          :session-id="playingItem.sessionId"
          :live-id="playingItem.liveId"
          :execution-mode="playingItem.executionMode"
        />
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
/**
 * 设置页「浏览器回放」（技术方案 2026-11-27 §6.2）：本人跨会话录制列表。
 * 数据源两路合并——CLOUD 走 GET /v1/browser-live/replays（size 上限 200，超出提示缩小范围），
 * LOCAL（仅 Electron）走 IPC replayListAll 扫本机 runtime；合并去重 + 客户端分页纯逻辑在
 * utils/browserReplayList（node 环境单测）。播放复用 BrowserLiveReplay（wrapper 补 provide）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Refresh } from '@element-plus/icons-vue'
import { getSession, listBrowserReplaysAll } from '../../api'
import type { BrowserReplayListItem } from '@mao/contracts'
import BrowserReplayPlayer from '../../components/browser/BrowserReplayPlayer.vue'
import { isElectronClient } from '../../utils/platform'
import { formatDateTime } from '../../utils/datetime'
import {
  BROWSER_REPLAY_MODE_OPTIONS,
  BROWSER_REPLAY_RANGE_DEFAULT,
  BROWSER_REPLAY_RANGE_OPTIONS,
  LOCAL_META_FOREIGN,
  REPLAY_BADGE_TRUNCATED,
  REPLAY_BADGE_UNSETTLED,
  defaultCustomRange,
  filterReplayRows,
  formatReplayBytes,
  formatReplayDuration,
  localMetaOutcomeFromError,
  mapWithConcurrency,
  mergeReplayRows,
  normalizeLocalSessionMeta,
  paginateReplayRows,
  replayRangeParams,
  replayRowKey,
  replayRowTitle,
  resolveReplayWindow,
  type BrowserReplayModeFilter,
  type BrowserReplayRange,
  type LocalMetaOutcome,
  type LocalReplayRow,
  type LocalSessionMeta,
} from '../../utils/browserReplayList'

const router = useRouter()

/** 云端一次拉取的上限（后端 size 上限 200）；超出只提示，不静默丢数据。 */
const CLOUD_FETCH_SIZE = 200
const PAGE_SIZE = 20
/** 批量补 LOCAL 会话元数据的并发上限（方案 §6.2）。 */
const META_CONCURRENCY = 5
/** loadAll 请求序号：旧响应后落地时丢弃（P2-1，与 admin BrowserReplayListView 同款守卫）。 */
let loadSeq = 0

// ---------- 筛选状态 ----------
const range = ref<BrowserReplayRange>(BROWSER_REPLAY_RANGE_DEFAULT)
const customRange = ref<[string, string]>(defaultCustomRange())
const mode = ref<BrowserReplayModeFilter>('ALL')
const keyword = ref('')
const page = ref(1)

/** 非 Electron 没有本机 IPC：模式筛选不含 LOCAL。 */
const localAvailable = ref(false)
const modeOptions = computed(() => (
  localAvailable.value ? BROWSER_REPLAY_MODE_OPTIONS : BROWSER_REPLAY_MODE_OPTIONS.filter((o) => o.value !== 'LOCAL')
))

// ---------- 数据 ----------
const loading = ref(false)
const loadError = ref('')
const cloudRows = ref<BrowserReplayListItem[]>([])
const cloudTotal = ref(0)
const truncatedCandidates = ref(false)
const localRows = ref<LocalReplayRow[]>([])
/** 本机扫描触达上限（2000 场 / 2000 个会话目录）：提示缩小时间范围，不静默丢数据。 */
const localTruncated = ref(false)
/** sessionId → 会话元数据；null = 取不到（已删除 / 请求失败），展示回落占位标题。 */
const localMeta = ref(new Map<number, LocalSessionMeta | null>())

const rows = computed(() => mergeReplayRows(cloudRows.value, localRows.value, localMeta.value))
const filtered = computed(() => filterReplayRows(rows.value, { mode: mode.value, keyword: keyword.value }))
const pagedRows = computed(() => paginateReplayRows(filtered.value, page.value, PAGE_SIZE))

function rowKey(row: BrowserReplayListItem): string {
  return replayRowKey(row.sessionId, row.liveId, row.executionMode)
}

// ---------- 本机 IPC 特性探测（旧主进程没有 replayListAll，与 browserReplayProvider 同口径） ----------
interface LocalReplayScan {
  rows: LocalReplayRow[]
  truncated: boolean
}

interface LocalReplayApi {
  replayListAll(from: number | null, to: number | null): Promise<LocalReplayScan>
}

function localReplayApi(): LocalReplayApi | null {
  if (!isElectronClient()) return null
  const api = (window as unknown as { electronAPI?: { browserLive?: Partial<LocalReplayApi> } }).electronAPI?.browserLive
  return typeof api?.replayListAll === 'function' ? (api as LocalReplayApi) : null
}

/** 只取数不落状态：渲染层在 loadAll 的序号守卫后统一应用，避免旧响应后落地冲掉新结果。 */
async function scanLocalReplays(from: number | null, to: number | null): Promise<LocalReplayScan> {
  const api = localReplayApi()
  if (!api) return { rows: [], truncated: false }
  try {
    const scan = (await api.replayListAll(from, to)) ?? { rows: [], truncated: false }
    return { rows: scan.rows ?? [], truncated: scan.truncated === true }
  } catch {
    return { rows: [], truncated: false }
  }
}

/** LOCAL 行按 sessionId 批量补标题 / Agent（并发上限 5，view 内缓存，失败回落「会话 #id（已删除）」）。 */
async function fillLocalMeta(): Promise<void> {
  const ids = [...new Set(localRows.value.map((row) => row.sessionId))]
    .filter((id) => !localMeta.value.has(id))
  if (ids.length === 0) return
  const outcomes = await mapWithConcurrency(ids, META_CONCURRENCY, async (id): Promise<LocalMetaOutcome> => {
    try {
      return normalizeLocalSessionMeta(await getSession(id, { skipErrorToast: true }))
    } catch (e) {
      // 403 = 会话不归属当前用户（共用设备上他人账号遗留的本机录制）：标记剔行，
      // 不当「已删除」展示；skipErrorToast 压制拦截器误弹的「无权限」条
      return localMetaOutcomeFromError(e)
    }
  })
  const foreignIds = new Set<number>()
  outcomes.forEach((outcome, index) => {
    const id = ids[index]!
    if (outcome === LOCAL_META_FOREIGN) foreignIds.add(id)
    else localMeta.value.set(id, outcome)
  })
  if (foreignIds.size > 0) {
    localRows.value = localRows.value.filter((row) => !foreignIds.has(row.sessionId))
  }
}

async function loadAll(refresh = false): Promise<void> {
  // 请求序号守卫：快速切换时间范围时，慢的旧响应后落地会冲掉新范围结果（与 admin 同款口径）
  const seq = ++loadSeq
  loading.value = true
  loadError.value = ''
  const window_ = resolveReplayWindow(range.value, customRange.value)
  try {
    const cloud = listBrowserReplaysAll({
      ...replayRangeParams(range.value, customRange.value),
      size: CLOUD_FETCH_SIZE,
      refresh,
    })
    const local = scanLocalReplays(window_.from, window_.to)
    const [cloudResult, localResult] = await Promise.allSettled([cloud, local])
    if (seq !== loadSeq) return // 已发新请求：丢弃本次结果（含 LOCAL 扫描，防旧响应后落地）
    if (localResult.status === 'fulfilled') {
      localRows.value = localResult.value.rows
      localTruncated.value = localResult.value.truncated
    } else {
      localRows.value = []
      localTruncated.value = false
    }
    if (cloudResult.status === 'fulfilled') {
      cloudRows.value = cloudResult.value.records ?? []
      cloudTotal.value = cloudResult.value.total ?? 0
      truncatedCandidates.value = cloudResult.value.truncatedCandidates === true
    } else {
      cloudRows.value = []
      cloudTotal.value = 0
      truncatedCandidates.value = false
      loadError.value = '云端回放列表加载失败'
    }
    await fillLocalMeta()
    if (seq !== loadSeq) return // fillLocalMeta 期间又发了新请求
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

// 时间范围变化才重新拉取（模式 / 关键词是客户端过滤，只重置分页）
watch([range, customRange], () => {
  page.value = 1
  void loadAll()
}, { immediate: true })

watch([mode, keyword], () => { page.value = 1 })

// ---------- 播放弹窗 ----------
const playVisible = ref(false)
const playingItem = ref<BrowserReplayListItem | null>(null)
const playTitle = computed(() => (playingItem.value ? `回放 · ${replayRowTitle(playingItem.value)}` : '回放'))

function openPlay(row: BrowserReplayListItem): void {
  playingItem.value = row
  playVisible.value = true
}

function openSession(sessionId: number): void {
  void router.push(`/tasks/${sessionId}`)
}

// ---------- 移动端全屏 ----------
const isMobileViewport = ref(false)
function syncViewport(): void {
  isMobileViewport.value = typeof window !== 'undefined' && window.innerWidth <= 768
}

onMounted(() => {
  localAvailable.value = localReplayApi() != null
  syncViewport()
  window.addEventListener('resize', syncViewport)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', syncViewport)
})
</script>

<style scoped>
.browser-replays-page {
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

.source-alert {
  max-width: 860px;
}

.source-alert :deep(.el-alert__title) {
  font-size: 12px;
  line-height: 1.5;
}

.card {
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider-soft);
  border-radius: 8px;
  padding: 14px 16px;
  max-width: 860px;
}

.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.filter-range {
  width: 132px;
  flex: none;
}

.filter-mode {
  width: 148px;
  flex: none;
}

.filter-keyword {
  width: 200px;
  flex: none;
}

.refresh-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: var(--aw-btn-height);
  padding: var(--aw-btn-padding);
  border: 1px solid var(--aw-divider);
  border-radius: var(--aw-radius-xs);
  background: var(--aw-surface);
  color: var(--aw-ink-muted);
  font-size: var(--aw-text-fine);
  cursor: pointer;
  flex: none;
}

.refresh-btn:hover {
  color: var(--aw-ink);
  background: var(--aw-surface-hover);
}

.list-alert {
  margin-bottom: 10px;
}

.retry-btn {
  margin-left: 8px;
  padding: 2px 10px;
  border: 1px solid var(--aw-divider);
  border-radius: var(--aw-radius-xs);
  background: var(--aw-surface);
  color: var(--aw-ink);
  font-size: 12px;
  cursor: pointer;
}

.empty-state {
  text-align: center;
  padding: 28px 16px;
  color: var(--aw-ink-muted);
  font-size: 13px;
}

.empty-main {
  margin: 0 0 8px;
  font-size: 14px;
  color: var(--aw-ink);
}

.empty-sub {
  margin: 0 auto;
  max-width: 460px;
  font-size: 12px;
  line-height: 1.6;
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
  min-width: 0;
}

.session-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.item-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.text-btn {
  padding: 3px 8px;
  border: none;
  border-radius: var(--aw-radius-xs);
  background: transparent;
  color: var(--aw-primary);
  font-size: 12px;
  cursor: pointer;
}

.text-btn:hover {
  background: var(--aw-primary-lighter);
}

.item-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--aw-ink-muted);
}

.url-text {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  flex: none;
}

.badge-cloud {
  background: var(--aw-primary-lighter);
  color: var(--aw-primary);
}

.badge-local {
  background: rgba(139, 92, 246, 0.12);
  color: #7c3aed;
}

.badge-warn {
  background: rgba(245, 158, 11, 0.14);
  color: #d97706;
}

.badge-danger {
  background: rgba(239, 68, 68, 0.12);
  color: #dc2626;
}

.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}

/* 播放弹窗：内容区贴边，舞台高度随视口；全屏（安卓）时撑满可用高度 */
.replay-dialog :deep(.el-dialog__body) {
  padding: 0;
}

.replay-stage-wrap {
  height: min(70vh, 620px);
  display: flex;
  flex-direction: column;
}

@media (max-width: 768px) {
  .replay-stage-wrap {
    height: calc(100vh - 140px);
  }
}
</style>
