<template>
  <div class="browser-replay-player">
    <!-- 载入中 -->
    <div v-if="state === 'loading'" v-loading="true" class="stage stage-placeholder">正在加载回放…</div>

    <!-- timeline 404：场次已被清理 / 从未录制（后端空 body，按 HTTP 状态判定） -->
    <el-empty v-else-if="state === 'missing'" :description="BROWSER_REPLAY_MISSING_TEXT" :image-size="80" />

    <!-- 其它失败（网络/500 等）：保留重试 -->
    <div v-else-if="state === 'error'" class="stage-error">
      <el-alert type="error" :closable="false" show-icon title="回放加载失败" description="加载回放数据失败，请重试。" />
      <el-button type="primary" :loading="loading" @click="loadTimeline">重试</el-button>
    </div>

    <!-- 播放态 -->
    <template v-else-if="timeline">
      <div class="replay-meta">
        <span class="replay-meta-item">会话 #{{ sessionId }}</span>
        <span class="replay-meta-item">{{ liveId }}</span>
        <span class="replay-meta-item">{{ frames.length }} 帧</span>
        <span class="replay-meta-item">{{ formatReplayTime(timeline.manifest.startedAt) }}</span>
        <el-tag v-if="timeline.manifest.truncated" type="danger" size="small">已截断</el-tag>
      </div>

      <div class="replay-stage">
        <canvas ref="canvasRef" class="replay-canvas" />
        <div v-if="frameMissing" class="replay-hint overlay">该帧数据不可用（可能已被清理）</div>
      </div>

      <div class="timeline-wrap">
        <svg
          class="replay-timeline"
          viewBox="0 0 1000 28"
          preserveAspectRatio="none"
          @pointerdown="onTimelinePointerDown"
          @pointermove="onTimelinePointerMove"
          @pointerup="onTimelinePointerUp"
          @pointerleave="onTimelineLeave"
        >
          <rect
            v-for="bar in bars"
            :key="bar.seq"
            :x="bar.x"
            :y="28 - bar.h"
            width="3"
            :height="bar.h"
            :fill="bar.seq === (frames[currentIdx]?.seq ?? -1) ? '#4da3ff' : '#3a6ea5'"
            :fill-opacity="bar.opacity"
          />
        </svg>
        <div v-if="tooltip" class="timeline-tooltip" :style="{ left: `${tooltip.x}%` }">
          {{ tooltip.text }}
        </div>
      </div>

      <div class="replay-controls">
        <el-button-group>
          <el-tooltip content="跳到开头" placement="top">
            <el-button size="small" aria-label="跳到开头" title="跳到开头" @click="seek(0)">
              <el-icon><DArrowLeft /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip content="上一帧" placement="top">
            <el-button size="small" aria-label="上一帧" title="上一帧" @click="step(-1)">
              <el-icon><ArrowLeft /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip :content="playing ? '暂停' : '播放'" placement="top">
            <el-button
              size="small"
              :aria-label="playing ? '暂停' : '播放'"
              :title="playing ? '暂停' : '播放'"
              @click="togglePlay"
            >
              <el-icon><VideoPause v-if="playing" /><VideoPlay v-else /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip content="下一帧" placement="top">
            <el-button size="small" aria-label="下一帧" title="下一帧" @click="step(1)">
              <el-icon><ArrowRight /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip content="跳到结尾" placement="top">
            <el-button size="small" aria-label="跳到结尾" title="跳到结尾" @click="seek(frames.length - 1)">
              <el-icon><DArrowRight /></el-icon>
            </el-button>
          </el-tooltip>
        </el-button-group>
        <el-tooltip content="倍速，点击切换" placement="top">
          <el-button size="small" :aria-label="`倍速 ${speed}x，点击切换`" :title="`倍速 ${speed}x，点击切换`" @click="cycleSpeed">
            {{ speed }}x
          </el-button>
        </el-tooltip>
        <span class="time-label">{{ timeLabel }}</span>
        <el-button class="back-btn" size="small" @click="emit('close')">返回列表</el-button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 管理后台「浏览器回放」播放器（技术方案 2026-11-27 §5.3）：
 * 端口 desktop/src/components/browser/BrowserLiveReplay.vue 的帧级播放逻辑（无 route/store/WS 依赖），
 * 控件按 admin 惯例改用 Element Plus；数据仅走管理端 timeline / frames 只读端点。
 *
 * 关键差异：admin 的 axios 响应拦截器只放行 Result 信封，而 frames 端点返回裸 JPEG——
 * 必须 responseType:'blob' 走拦截器的二进制直通分支，并手动捕获 HTTP 404
 * （后端 404 是空 body `reply.status(404).send()`，不是信封错误码；范本 desktop/src/api/index.ts
 * 的 fetchBrowserReplayFrame，见 utils/replayPlayer.ts 的 httpStatusOf）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowLeft, ArrowRight, DArrowLeft, DArrowRight, VideoPause, VideoPlay } from '@element-plus/icons-vue'
import type { ReplayFrameMeta, ReplayTimeline } from '@mao/contracts'
import { api } from '../../api'
import { frameUrlFor, httpStatusOf, replayAdvanceIndex, replayBars, replayClock, replayIndexForRatio } from '../../utils/replayPlayer'
import { BROWSER_REPLAY_MISSING_TEXT, formatReplayTime } from '../../views/session/browserReplayFormat'

const props = defineProps<{
  sessionId: number
  liveId: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

type PlayerState = 'loading' | 'missing' | 'error' | 'ready'

const state = ref<PlayerState>('loading')
const loading = ref(false)
const timeline = ref<ReplayTimeline | null>(null)
const frames = computed<ReplayFrameMeta[]>(() => timeline.value?.frames ?? [])

async function loadTimeline() {
  loading.value = true
  state.value = 'loading'
  try {
    const { data } = await api.get<ReplayTimeline>(
      `/admin/browser-replays/${props.sessionId}/${encodeURIComponent(props.liveId)}/timeline`,
      { skipErrorToast: true } // 404（已被清理）是正常分支，不弹错误条
    )
    timeline.value = data ?? null
    if (!timeline.value || timeline.value.frames.length === 0) {
      state.value = 'missing'
      return
    }
    frameCacheClear()
    state.value = 'ready'
    seek(0)
  } catch (e) {
    if (httpStatusOf(e) === 404) {
      state.value = 'missing'
      return
    }
    state.value = 'error'
  } finally {
    loading.value = false
  }
}

// ---------- 播放器 ----------
const currentIdx = ref(-1)
const playing = ref(false)
const speed = ref(1)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const frameMissing = ref(false)

/** seq → objectURL（拉取成功才缓存，失败不缓存避免瞬时故障被钉死）；卸载时统一 revoke。 */
const frameCache = new Map<number, string>()
/** in-flight 去重：tick 与预取并发时同一 seq 只发一次请求。 */
const frameInFlight = new Map<number, Promise<string | null>>()
const FRAME_CACHE_LIMIT = 50
let playheadTs = 0
let lastTickAt = 0
let tickTimer: ReturnType<typeof setInterval> | null = null
/** 期望绘制的帧索引：图像异步加载完成时若期望已变则丢弃（与桌面端同纪律）。 */
let drawTarget = -1
let pendingImage: HTMLImageElement | null = null
/** pendingImage 正在加载的 objectURL：淘汰 / 清缓存时必须跳过，否则该帧绘制失败。 */
let pendingImageUrl: string | null = null

/** 安全 revoke：跳过挂在 onload 等待中的那一张（其 img 仍在用该 URL）。 */
function revokeFrameUrl(url: string): void {
  if (pendingImageUrl != null && url === pendingImageUrl) return
  URL.revokeObjectURL(url)
}

function frameCachePut(seq: number, url: string) {
  if (frameCache.size >= FRAME_CACHE_LIMIT && !frameCache.has(seq)) {
    const firstKey = frameCache.keys().next().value
    if (firstKey != null) {
      revokeFrameUrl(frameCache.get(firstKey)!)
      frameCache.delete(firstKey)
    }
  }
  frameCache.set(seq, url)
}

function frameCacheClear() {
  for (const url of frameCache.values()) revokeFrameUrl(url)
  frameCache.clear()
}

/** 单帧 JPEG 的 objectURL；404（已被清理）/ 空 body 返回 null，网络故障不缓存下一轮重试。 */
async function ensureFrame(seq: number): Promise<string | null> {
  const cached = frameCache.get(seq)
  if (cached) return cached
  const inFlight = frameInFlight.get(seq)
  if (inFlight) return inFlight
  const pending = (async () => {
    try {
      const res = await api.get<Blob>(frameUrlFor(props.sessionId, props.liveId, seq), {
        responseType: 'blob', // 裸 JPEG 走拦截器二进制直通分支，非 Result 信封
        skipErrorToast: true
      })
      const blob = res?.data
      if (!blob || blob.size === 0) return null
      return URL.createObjectURL(blob)
    } catch {
      // 404（帧已被清理）与网络故障都不缓存：前者走占位提示，后者下一轮 tick / 预取重试
      return null
    }
  })()
  frameInFlight.set(seq, pending)
  const url = await pending
  frameInFlight.delete(seq)
  if (url) frameCachePut(seq, url)
  return url
}

/** 绘制目标索引帧：加载完成回叫时对账，索引落后才补画。 */
async function drawAt(idx: number) {
  drawTarget = idx
  const frame = frames.value[idx]
  if (!frame) {
    const ctx = canvasRef.value?.getContext('2d')
    if (canvasRef.value) ctx?.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height)
    return
  }
  const url = await ensureFrame(frame.seq)
  if (drawTarget !== idx || !canvasRef.value) return
  if (!url) {
    frameMissing.value = true
    return
  }
  frameMissing.value = false
  const img = new Image()
  pendingImage = img
  pendingImageUrl = url
  img.onload = () => {
    if (pendingImage !== img || !canvasRef.value) return
    pendingImageUrl = null // 已绘制：该 URL 重新纳入可淘汰集合
    const canvas = canvasRef.value
    canvas.width = img.naturalWidth || frame.width || canvas.clientWidth
    canvas.height = img.naturalHeight || frame.height || canvas.clientHeight
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
  }
  img.onerror = () => {
    // 加载失败：解除占用，让该 URL 可被正常淘汰（下一轮 tick / 预取会重试）
    if (pendingImage === img) {
      pendingImage = null
      pendingImageUrl = null
    }
  }
  img.src = url
  // 预取前后各 2 帧，倍速播放靠预取平滑
  for (const offset of [-1, 1, -2, 2]) {
    const neighbor = frames.value[idx + offset]
    if (neighbor && !frameCache.has(neighbor.seq)) void ensureFrame(neighbor.seq)
  }
}

function seek(idx: number) {
  if (frames.value.length === 0) return
  const target = Math.max(0, Math.min(frames.value.length - 1, idx))
  currentIdx.value = target
  playheadTs = frames.value[target].ts
  void drawAt(target)
}

function step(delta: number) {
  pause()
  seek(currentIdx.value + delta)
}

function togglePlay() {
  if (playing.value) {
    pause()
    return
  }
  if (currentIdx.value >= frames.value.length - 1) seek(0)
  playing.value = true
  lastTickAt = Date.now()
  tickTimer = setInterval(tick, 120)
}

function pause() {
  playing.value = false
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
}

function tick() {
  const now = Date.now()
  const list = frames.value
  if (list.length === 0) { pause(); return }
  playheadTs += (now - lastTickAt) * speed.value
  lastTickAt = now
  if (playheadTs >= list[list.length - 1].ts) {
    seek(list.length - 1)
    pause()
    return
  }
  const idx = replayAdvanceIndex(list, currentIdx.value, playheadTs)
  if (idx !== currentIdx.value) {
    currentIdx.value = idx
    void drawAt(idx)
  }
}

function cycleSpeed() {
  speed.value = speed.value === 1 ? 2 : speed.value === 2 ? 4 : 1
}

/** 时间轴密度带（几何在 utils/replayPlayer，可单测）。 */
const bars = computed(() => replayBars(frames.value))

// ---------- 时间轴交互：点击 / 拖拽定位 + hover 时间点 / pageUrl ----------
const tooltip = ref<{ x: number; text: string } | null>(null)
let dragging = false

function timelineRatio(e: PointerEvent | MouseEvent): number {
  const rect = (e.currentTarget as Element).getBoundingClientRect()
  return (e.clientX - rect.left) / Math.max(1, rect.width)
}

function onTimelinePointerDown(e: PointerEvent) {
  if (frames.value.length === 0) return
  dragging = true
  ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  seek(replayIndexForRatio(frames.value, timelineRatio(e)))
}

function onTimelinePointerMove(e: PointerEvent) {
  if (dragging && frames.value.length > 0) {
    seek(replayIndexForRatio(frames.value, timelineRatio(e)))
  }
  // hover 提示：场内相对时间 + pageUrl
  const list = frames.value
  if (list.length === 0) return
  const idx = replayIndexForRatio(list, timelineRatio(e))
  const frame = list[idx]
  if (!frame) { tooltip.value = null; return }
  tooltip.value = {
    x: Math.max(0, Math.min(100, timelineRatio(e) * 100)),
    text: `${replayClock(frame.ts - list[0].ts)} · ${frame.pageUrl}`,
  }
}

function onTimelinePointerUp(e: PointerEvent) {
  dragging = false
  ;(e.currentTarget as Element).releasePointerCapture?.(e.pointerId)
}

function onTimelineLeave() {
  dragging = false
  tooltip.value = null
}

const timeLabel = computed(() => {
  const list = frames.value
  if (list.length === 0) return '00:00 / 00:00'
  const cur = Math.max(0, currentIdx.value)
  return `${replayClock(list[cur].ts - list[0].ts)} / ${replayClock(list[list.length - 1].ts - list[0].ts)}`
})

// 打开即拉 timeline（挂载后发起，保证 canvas 已就绪）；liveId 变化（异常复用场景）重新装载
onMounted(() => {
  void loadTimeline()
})

watch(() => props.liveId, () => {
  void loadTimeline()
})

onBeforeUnmount(() => {
  pause()
  pendingImage = null
  frameCacheClear()
  // 卸载即组件销毁：不会有 onload 再来，补 revoke 挂在等待中的那一张，避免泄漏
  if (pendingImageUrl != null) {
    URL.revokeObjectURL(pendingImageUrl)
    pendingImageUrl = null
  }
})
</script>

<style scoped>
.browser-replay-player {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
}

.replay-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.replay-meta-item {
  font-variant-numeric: tabular-nums;
}

.replay-stage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 320px;
  background: #101014;
  border-radius: 6px;
  overflow: hidden;
}

.stage-placeholder {
  min-height: 320px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.stage-error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  min-height: 200px;
  justify-content: center;
}

.replay-canvas {
  max-width: 100%;
  max-height: 56vh;
  object-fit: contain;
}

.replay-hint {
  color: #9a9aae;
  font-size: 13px;
}

.replay-hint.overlay {
  position: absolute;
  bottom: 8px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(26, 26, 33, 0.9);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 11px;
  color: #e6e6eb;
}

.timeline-wrap {
  position: relative;
}

.replay-timeline {
  display: block;
  width: 100%;
  height: 28px;
  background: #16161c;
  border-radius: 4px;
  cursor: pointer;
  touch-action: none;
}

.timeline-tooltip {
  position: absolute;
  bottom: 32px;
  transform: translateX(-50%);
  max-width: 60%;
  padding: 3px 8px;
  background: rgba(26, 26, 33, 0.95);
  border: 1px solid #2c2c36;
  border-radius: 6px;
  font-size: 11px;
  color: #c8c8d4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}

.replay-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.time-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
  margin-left: 4px;
}

.back-btn {
  margin-left: auto;
}
</style>
