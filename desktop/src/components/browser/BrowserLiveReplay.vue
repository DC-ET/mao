<template>
  <div class="browser-replay">
    <!-- 场次列表态 -->
    <div v-if="!current" class="replay-list">
      <div v-if="!provider" class="replay-hint">
        {{ props.sessionId == null ? '尚未进入会话' : '当前端无法读取回放数据（LOCAL 会话仅在执行设备上可回看）' }}
      </div>
      <div v-else-if="loading" class="replay-hint">加载回放列表…</div>
      <template v-else-if="summaries.length === 0">
        <p class="replay-empty">暂无历史回放</p>
        <p class="replay-empty-sub">管理员开启「系统设置 → 浏览器直播 → 启用操作录制」后，此后的浏览器操作会自动录制</p>
      </template>
      <ul v-else class="replay-items">
        <li v-for="item in summaries" :key="item.liveId">
          <button type="button" class="replay-item" @click="open(item)">
            <span class="item-title">
              {{ formatDateTime(item.startedAt) }}
              <span v-if="item.endedAt == null" class="item-badge unsettled">未正常结束</span>
              <span v-if="item.truncated" class="item-badge truncated">已截断</span>
            </span>
            <span class="item-meta">{{ formatDuration(item.durationMs) }} · {{ item.frameCount }} 帧 · {{ formatBytes(item.approxBytes) }}</span>
          </button>
        </li>
      </ul>
    </div>

    <!-- 播放态 -->
    <template v-else>
      <div class="replay-stage">
        <canvas ref="canvasRef" class="replay-canvas"></canvas>
        <div v-if="frameMissing" class="replay-hint overlay">该帧数据不可用（可能已被清理）</div>
      </div>
      <div class="timeline-wrap">
        <svg
          class="replay-timeline"
          :viewBox="`0 0 1000 28`"
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
        <button class="ctl" type="button" aria-label="跳到开头" title="跳到开头" @click="seek(0)">⏮</button>
        <button class="ctl step-btn" type="button" aria-label="上一帧" title="上一帧" @click="step(-1)">◀</button>
        <button class="ctl play-btn" type="button" :aria-label="playing ? '暂停' : '播放'" :title="playing ? '暂停' : '播放'" @click="togglePlay">
          {{ playing ? '⏸' : '▶' }}
        </button>
        <button class="ctl step-btn" type="button" aria-label="下一帧" title="下一帧" @click="step(1)">▶</button>
        <button class="ctl" type="button" aria-label="跳到结尾" title="跳到结尾" @click="seek(frames.length - 1)">⏭</button>
        <button class="ctl speed-btn" type="button" :aria-label="`倍速 ${speed}x，点击切换`" :title="`倍速 ${speed}x，点击切换`" @click="cycleSpeed">{{ speed }}x</button>
        <span class="time-label">{{ timeLabel }}</span>
        <span v-if="current.manifest.truncated" class="item-badge truncated">已截断</span>
        <button class="ctl back-btn" type="button" @click="backToList">返回场次列表</button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 浏览器直播回放（V202，技术方案 §5.2）：场次列表 + 帧级播放器。
 * 数据经 browserReplayProvider 双路分流（CLOUD axios / LOCAL 主进程 IPC）。
 * 播放按帧 ts 差推进（倍速），回放按帧索引驱动绘制——与直播的 base64 内容去重不同，
 * seek/step 直接指定目标索引，绘制完成回叫对账（索引落后才补画）。
 * 时间轴密度带 / 定位 / 推进的几何与逻辑抽在 utils/replayPlayer（纯函数，可单测）。
 */
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { ReplayFrameMeta, ReplaySummary, ReplayTimeline } from '@mao/contracts'
import { createBrowserReplayProvider, type BrowserReplayProvider } from '../../composables/browserReplayProvider'
import { formatDateTime } from '../../utils/datetime'
import { replayAdvanceIndex, replayBars, replayClock, replayIndexForRatio } from '../../utils/replayPlayer'

const props = defineProps<{ sessionId: number | null }>()

const executionMode = inject<Ref<string>>('executionMode', ref('CLOUD'))
const provider = computed<BrowserReplayProvider | null>(() => {
  if (props.sessionId == null) return null
  return createBrowserReplayProvider(executionMode.value)
})

// ---------- 场次列表 ----------
const summaries = ref<ReplaySummary[]>([])
const loading = ref(false)
const current = ref<ReplayTimeline | null>(null)

async function loadList() {
  if (!provider.value || props.sessionId == null) {
    summaries.value = []
    return
  }
  loading.value = true
  try {
    summaries.value = await provider.value.list(props.sessionId)
  } catch {
    summaries.value = []
  } finally {
    loading.value = false
  }
}

watch(() => [props.sessionId, provider.value] as const, () => {
  backToList()
  void loadList()
}, { immediate: true })

function formatDuration(ms: number | null): string {
  if (ms == null || ms < 0) return '时长未知'
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total} 秒`
  return `${Math.floor(total / 60)} 分 ${total % 60} 秒`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// ---------- 播放器 ----------
const frames = computed<ReplayFrameMeta[]>(() => current.value?.frames ?? [])
const currentIdx = ref(-1)
const playing = ref(false)
const speed = ref(1)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const frameMissing = ref(false)

/** seq → base64 JPEG | null（拉取成功才缓存，失败不缓存避免瞬时故障被钉死）。 */
const frameCache = new Map<number, string | null>()
/** in-flight 去重：tick 与预取并发时同一 seq 只发一次请求（评审 P2-6）。 */
const frameInFlight = new Map<number, Promise<string | null>>()
const FRAME_CACHE_LIMIT = 50
let playheadTs = 0
let lastTickAt = 0
let tickTimer: ReturnType<typeof setInterval> | null = null
/** 期望绘制的帧索引：图像异步加载完成时若期望已变则丢弃（与直播 pendingImage 单飞同纪律） */
let drawTarget = -1
let pendingImage: HTMLImageElement | null = null

function cachePut(seq: number, value: string | null) {
  if (frameCache.size >= FRAME_CACHE_LIMIT && !frameCache.has(seq)) {
    const firstKey = frameCache.keys().next().value
    if (firstKey != null) frameCache.delete(firstKey)
  }
  frameCache.set(seq, value)
}

async function ensureFrame(seq: number): Promise<string | null> {
  if (frameCache.has(seq)) return frameCache.get(seq) ?? null
  const inFlight = frameInFlight.get(seq)
  if (inFlight) return inFlight
  const pending = (async () => {
    try {
      if (!provider.value || current.value == null || props.sessionId == null) return null
      return await provider.value.frame(props.sessionId, current.value.manifest.liveId, seq)
    } catch {
      return null // 网络故障不缓存，下一轮 tick / 预取重试
    }
  })()
  frameInFlight.set(seq, pending)
  const jpeg = await pending
  frameInFlight.delete(seq)
  if (jpeg) cachePut(seq, jpeg)
  return jpeg
}

/** 绘制目标索引帧：加载完成回叫时对账，索引落后才补画（§5.2 适配点 1）。 */
async function drawAt(idx: number) {
  drawTarget = idx
  const frame = frames.value[idx]
  if (!frame) {
    if (canvasRef.value) {
      const ctx = canvasRef.value.getContext('2d')
      ctx?.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height)
    }
    return
  }
  const jpeg = await ensureFrame(frame.seq)
  if (drawTarget !== idx || !canvasRef.value) return
  if (!jpeg) {
    frameMissing.value = true
    return
  }
  frameMissing.value = false
  const img = new Image()
  pendingImage = img
  img.onload = () => {
    if (pendingImage !== img || !canvasRef.value) return
    const canvas = canvasRef.value
    canvas.width = img.naturalWidth || frame.width || canvas.clientWidth
    canvas.height = img.naturalHeight || frame.height || canvas.clientHeight
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
  }
  img.src = `data:image/jpeg;base64,${jpeg}`
  // 预取前后各 2 帧，倍速播放靠预取平滑（§5.2 适配点 2）
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
  // hover 提示：时间点 + pageUrl（§5.2 时间轴承诺）
  const list = frames.value
  if (list.length === 0) return
  const idx = replayIndexForRatio(list, timelineRatio(e))
  const frame = list[idx]
  if (!frame) { tooltip.value = null; return }
  tooltip.value = {
    x: Math.max(0, Math.min(100, timelineRatio(e) * 100)),
    text: `${formatDateTime(frame.ts).slice(11)} · ${frame.pageUrl}`,
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

async function open(item: ReplaySummary) {
  if (!provider.value || props.sessionId == null) return
  let timeline: ReplayTimeline | null = null
  try {
    timeline = await provider.value.timeline(props.sessionId, item.liveId)
  } catch {
    return // 拉取失败保持列表态（404 已在 api 层转 null）
  }
  if (!timeline || timeline.frames.length === 0) return
  frameCache.clear()
  current.value = timeline
  seek(0)
}

function backToList() {
  pause()
  current.value = null
  currentIdx.value = -1
  drawTarget = -1
  frameCache.clear()
  frameMissing.value = false
  pendingImage = null
}

onBeforeUnmount(() => {
  pause()
  pendingImage = null
})
</script>

<style scoped>
.browser-replay {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: #101014;
  color: #e6e6eb;
  overflow: hidden;
  min-height: 0;
}
.replay-list {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}
.replay-hint {
  padding: 24px 12px;
  text-align: center;
  color: #6e6e80;
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
}
.replay-empty {
  margin: 32px 0 6px;
  text-align: center;
  font-size: 14px;
  color: #9a9aae;
}
.replay-empty-sub {
  margin: 0;
  text-align: center;
  font-size: 11px;
  color: #6e6e80;
  max-width: 360px;
  margin-left: auto;
  margin-right: auto;
}
.replay-items {
  list-style: none;
  margin: 0 auto;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 560px;
}
.replay-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  padding: 10px 14px;
  background: #1a1a21;
  border: 1px solid #2c2c36;
  border-radius: 8px;
  color: #e6e6eb;
  cursor: pointer;
  text-align: left;
}
.replay-item:hover {
  border-color: #4da3ff;
}
.item-title {
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.item-meta {
  font-size: 11px;
  color: #8a8a9c;
}
.item-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  flex: none;
}
.item-badge.unsettled {
  background: #4a3a20;
  color: #d9a441;
}
.item-badge.truncated {
  background: #45323a;
  color: #d9848f;
}
.replay-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.replay-canvas {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.timeline-wrap {
  position: relative;
  flex: none;
}
.replay-timeline {
  display: block;
  width: 100%;
  height: 28px;
  background: #16161c;
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
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: #1a1a21;
}
.ctl {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #c8c8d4;
  cursor: pointer;
  font-size: 13px;
  padding: 0 6px;
}
.ctl:hover {
  background: #2c2c36;
  color: #ffffff;
}
.play-btn {
  font-size: 16px;
}
.speed-btn {
  font-size: 11px;
  font-weight: 600;
  background: #2c2c36;
}
.time-label {
  font-size: 11px;
  color: #8a8a9c;
  font-variant-numeric: tabular-nums;
  margin-left: 4px;
}
.back-btn {
  margin-left: auto;
  font-size: 11px;
  color: #8a8a9c;
}
.back-btn:hover {
  color: #e6e6eb;
}
@media (max-width: 640px) {
  .step-btn {
    display: none;
  }
}
</style>
