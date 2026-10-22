<template>
  <div v-if="timeWindow != null" class="trace-time-band">
    <svg
      class="band-svg"
      viewBox="0 0 100 34"
      preserveAspectRatio="none"
      role="img"
      aria-label="run 时间概览"
      @mouseleave="hideTip"
    >
      <!-- 时间刻度行：横轴取节点估算起止的 min/max（不用墙钟，墙钟是跨度不是右端点） -->
      <line class="band-axis" x1="0" y1="0.5" x2="100" y2="0.5" vector-effect="non-scaling-stroke" />
      <template v-for="node in drawable" :key="node.key">
        <rect
          v-for="(seg, idx) in geometryOf(node)"
          :key="`${node.key}-${idx}`"
          class="band-bar"
          :class="[`bar-${node.kind}`, `bar-${node.status}`, { 'bar-decode': seg.part === 'decode', 'bar-active': isActive(node) }]"
          :x="seg.x"
          :y="laneY(node)"
          :width="Math.max(seg.width, 0.4)"
          :height="LANE_H"
          @mouseenter="showTip(node, $event)"
          @click="emit('locate', node.key)"
        />
      </template>
    </svg>
    <div class="band-legend">
      <span class="legend-item"><i class="dot dot-round" />轮次</span>
      <span class="legend-item"><i class="dot dot-tool" />工具</span>
      <span class="legend-item"><i class="dot dot-side" />旁路</span>
      <span v-if="skipped > 0" class="legend-skipped" :title="skippedHint">{{ skipped }} 项起止不可估算未画</span>
    </div>
    <!-- 自绘 tooltip：SVG 内定位文字会被 preserveAspectRatio 拉伸，用像素容器更可控 -->
    <div v-if="tip != null" class="band-tip" :style="tipStyle">
      <div class="tip-title">{{ tip.node.label }}</div>
      <div class="tip-row">起 估算 {{ tip.start }}</div>
      <div class="tip-row">止 估算 {{ tip.end }}</div>
      <div class="tip-row">耗时 {{ tip.duration }}</div>
      <div v-if="tip.decode" class="tip-row">首字 {{ tip.decode }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { RunTrace } from '../../types/trace'
import { runTimeNodes, runTimeWindow, timeBandGeometry, TIME_BAND_LANES, type TimeBandNode } from '../../utils/trace-display'

/**
 * run 内时间概览条带（技术方案 2026-10-22-run-trace-deep-dive §5.5）。
 *
 * 轮次 / 工具 / 旁路各一条泳道，起点 startedAtMs、宽度 durationMs；助手轮次分
 * 「首字 / 解码」两段。同一泳道内并行色条自然重叠——executeToolCalls 是 Promise.all，
 * 重叠即表达并行，不做堆叠避让（堆叠会让「谁在等谁」读不出来）。
 * 起止不可估算的节点不画色条（估算口径对用户可见：tooltip 与图例都标注）。
 */

const props = defineProps<{
  run: RunTrace
  /** 当前定位到的节点（`${runId}|${key}`）：只有同 run 的色条才高亮 */
  activeRunKey?: string | null
}>()

const emit = defineEmits<{
  locate: [key: string]
}>()

const LANE_H = 8
const LANE_GAP = 3
const AXIS_H = 2

const nodes = computed(() => runTimeNodes(props.run))
const timeWindow = computed(() => runTimeWindow(nodes.value))
const drawable = computed(() => nodes.value.filter((n) => n.startedAtMs != null && n.durationMs != null))
const skipped = computed(() => nodes.value.length - drawable.value.length)
const skippedHint = '这些行的 created_at 或 duration_ms 缺失：历史行 / 未回填行为空，按「不猜」口径不投影。'

function geometryOf(node: TimeBandNode) {
  if (timeWindow.value == null) return []
  const geo = timeBandGeometry(node, timeWindow.value, 100)
  if (geo == null) return []
  return geo.segments ?? [{ x: geo.x, width: geo.width, part: 'ttft' as const }]
}

function laneY(node: TimeBandNode): number {
  return AXIS_H + TIME_BAND_LANES[node.kind] * (LANE_H + LANE_GAP)
}

/** 高亮判定：activeRunKey 形如 `${runId}|${key}`，只点亮本 run 的那一条。
 *  不带 runId 的话，多个 run 同时展开时同名色条会一起高亮，用户看不出点的是哪个 run。 */
function isActive(node: TimeBandNode): boolean {
  if (props.activeRunKey == null) return false
  const sep = props.activeRunKey.indexOf('|')
  if (sep <= 0) return false
  const runId = props.activeRunKey.slice(0, sep)
  const key = props.activeRunKey.slice(sep + 1)
  return runId === String(props.run.runId) && key === node.key
}

interface Tip {
  node: TimeBandNode
  start: string
  end: string
  duration: string
  decode: string | null
  left: number
}

const tip = ref<Tip | null>(null)
let tipTimer: number | null = null

function fmtClock(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

function showTip(node: TimeBandNode, event: MouseEvent) {
  if (tipTimer != null) window.clearTimeout(tipTimer)
  // 事件派发一结束 currentTarget 就被规范重置为 null，宿主元素与坐标必须在同步期取，
  // 不能留到 setTimeout 回调里读（异步读会抛 TypeError，tooltip 全程不显示）。
  const host = (event.currentTarget as SVGElement | null)?.ownerSVGElement?.parentElement ?? null
  const clientX = event.clientX
  // 300ms 延迟：色条密集时鼠标划过不弹一串 tooltip（与面板 el-tooltip 的 show-after 习惯一致）
  tipTimer = window.setTimeout(() => {
    if (node.startedAtMs == null || node.durationMs == null) return
    const rect = host?.getBoundingClientRect()
    tip.value = {
      node,
      start: fmtClock(node.startedAtMs),
      end: fmtClock(node.startedAtMs + node.durationMs),
      duration: fmtMs(node.durationMs),
      decode: node.firstTokenMs != null && node.firstTokenMs > 0 && node.firstTokenMs < node.durationMs
        ? `首字 ${fmtMs(node.firstTokenMs)}`
        : null,
      left: rect != null ? Math.min(Math.max(clientX - rect.left + 10, 4), Math.max(rect.width - 190, 4)) : 4,
    }
  }, 300)
}

function hideTip() {
  if (tipTimer != null) window.clearTimeout(tipTimer)
  tipTimer = null
  tip.value = null
}

const tipStyle = computed(() => ({ left: `${tip.value?.left ?? 0}px` }))
</script>

<style scoped>
.trace-time-band {
  position: relative;
  margin-bottom: var(--aw-space-xxs);
  padding: 2px 0 0;
}

.band-svg {
  display: block;
  width: 100%;
  height: 36px;
}

.band-axis {
  stroke: var(--aw-hairline);
  stroke-width: 1;
}

/* 色条基色：轮次主色、工具中性、旁路弱化；深浅两段区分首字与解码 */
.band-bar {
  cursor: pointer;
}

.band-bar.bar-round {
  fill: var(--aw-primary);
}

.band-bar.bar-tool {
  fill: var(--aw-ink-muted-40);
}

.band-bar.bar-side {
  fill: var(--aw-diff-info);
}

.band-bar.bar-error {
  fill: var(--aw-danger);
}

.band-bar.bar-interrupted {
  fill: var(--aw-warning);
}

/* 解码段同色 55% 透明：与首字段连续，但一眼能看出「等首字花了多久」 */
.band-bar.bar-decode {
  opacity: 0.55;
}

/* 当前定位节点：白色描边把色条从泳道里拎出来（不靠改色，避免与状态色冲突） */
.band-bar.bar-active {
  stroke: var(--aw-ink);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.band-legend {
  display: flex;
  align-items: center;
  gap: var(--aw-space-xxs);
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-40);
  padding-top: 2px;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 2px;
  display: inline-block;
}

.dot-round {
  background: var(--aw-primary);
}

.dot-tool {
  background: var(--aw-ink-muted-40);
}

.dot-side {
  background: var(--aw-diff-info);
}

.legend-skipped {
  margin-left: auto;
  cursor: help;
}

.band-tip {
  position: absolute;
  top: 38px;
  z-index: 5;
  min-width: 150px;
  max-width: 220px;
  padding: var(--aw-space-xxs) 6px;
  border: 1px solid var(--aw-hairline);
  border-radius: var(--aw-radius-xs);
  background: var(--aw-surface);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-64);
  pointer-events: none;
}

.tip-title {
  font-weight: 600;
  color: var(--aw-ink);
  padding-bottom: 2px;
  word-break: break-all;
}

.tip-row {
  font-family: var(--aw-font-mono);
  white-space: nowrap;
}

/* Dark mode */
[data-theme="dark"] .band-tip {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}
</style>
