<template>
  <!-- 连线层按 viewBox 纵向拉伸铺满行高（行高随字号 / 展开区变化），圆点用 HTML 叠加避免被拉成椭圆 -->
  <span class="git-graph-cell" :style="{ width: `${width}px` }" aria-hidden="true">
    <svg class="git-graph-svg" :viewBox="`0 0 ${width} ${ROW_H}`" preserveAspectRatio="none">
      <template v-if="row">
        <path
          v-for="(seg, i) in row.top"
          :key="`t${i}`"
          :d="topPath(seg)"
          :class="`gc${seg.color}`"
        />
        <path
          v-for="(seg, i) in row.bottom"
          :key="`b${i}`"
          :d="bottomPath(seg)"
          :class="[`gc${seg.color}`, { 'is-dangling': danglingBottom }]"
        />
      </template>
      <template v-else-if="passLanes">
        <path
          v-for="pass in passLanes"
          :key="`p${pass.lane}`"
          :d="`M ${x(pass.lane)} 0 L ${x(pass.lane)} ${ROW_H}`"
          :class="`gc${pass.color}`"
        />
      </template>
    </svg>
    <span
      v-if="row"
      class="git-graph-node"
      :class="[`gn${row.color}`, { 'is-merge': row.isMerge || hidden > 0 }]"
      :style="{ left: `${x(row.lane)}px` }"
      :title="hidden > 0 ? `另有 ${hidden} 条分支线未展开` : undefined"
    />
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { hiddenLaneCount, visibleLane, type GitGraphLane, type GitGraphRow, type GitGraphSegment } from '../../utils/git-graph'

const LANE_W = 14
const ROW_H = 32
const MID = ROW_H / 2

const props = defineProps<{
  /** 可见列数（已钳制），决定宽度；整页统一以保证哈希列对齐 */
  lanes: number
  /** 提交行：画圆点与上下半段连线 */
  row?: GitGraphRow
  /** 展开区：只画穿行竖线 */
  passLanes?: GitGraphLane[]
  /** 列表已到底、最后一行仍有悬空的父提交线：下半段渐隐 */
  danglingBottom?: boolean
}>()

const width = computed(() => Math.max(1, props.lanes) * LANE_W)
const hidden = computed(() => (props.row ? hiddenLaneCount(props.row) : 0))

function x(lane: number): number {
  return visibleLane(lane) * LANE_W + LANE_W / 2
}

function curve(seg: GitGraphSegment, y1: number, y2: number): string {
  const x1 = x(seg.from)
  const x2 = x(seg.to)
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`
  const ym = (y1 + y2) / 2
  return `M ${x1} ${y1} C ${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`
}

const topPath = (seg: GitGraphSegment) => curve(seg, 0, MID)
const bottomPath = (seg: GitGraphSegment) => curve(seg, MID, ROW_H)
</script>

<style scoped>
.git-graph-cell {
  --git-graph-0: #0a84ff;
  --git-graph-1: #ff9f0a;
  --git-graph-2: #30b158;
  --git-graph-3: #af52de;
  --git-graph-4: #ff375f;
  --git-graph-5: #00a3bf;
  --git-graph-6: #c9a100;
  --git-graph-7: #8e6e53;
  position: relative;
  flex-shrink: 0;
  align-self: stretch;
  display: block;
}

[data-theme="dark"] .git-graph-cell {
  --git-graph-0: #4ba3ff;
  --git-graph-1: #e8a33d;
  --git-graph-2: #4cc472;
  --git-graph-3: #bf7fe0;
  --git-graph-4: #f0607e;
  --git-graph-5: #3ab8cc;
  --git-graph-6: #d4b440;
  --git-graph-7: #b0937a;
}

.git-graph-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.git-graph-svg path {
  fill: none;
  stroke-width: 1.6;
  vector-effect: non-scaling-stroke;
  stroke-linecap: round;
}

.git-graph-svg path.is-dangling {
  stroke-dasharray: 2 3;
  opacity: 0.5;
}

.gc0 { stroke: var(--git-graph-0); }
.gc1 { stroke: var(--git-graph-1); }
.gc2 { stroke: var(--git-graph-2); }
.gc3 { stroke: var(--git-graph-3); }
.gc4 { stroke: var(--git-graph-4); }
.gc5 { stroke: var(--git-graph-5); }
.gc6 { stroke: var(--git-graph-6); }
.gc7 { stroke: var(--git-graph-7); }

.git-graph-node {
  position: absolute;
  top: 50%;
  width: 8px;
  height: 8px;
  margin: -4px 0 0 -4px;
  border-radius: 50%;
  box-sizing: border-box;
  background: var(--node-color);
}

.git-graph-node.is-merge {
  border: 2px solid var(--node-color);
  background: var(--aw-surface);
}

.gn0 { --node-color: var(--git-graph-0); }
.gn1 { --node-color: var(--git-graph-1); }
.gn2 { --node-color: var(--git-graph-2); }
.gn3 { --node-color: var(--git-graph-3); }
.gn4 { --node-color: var(--git-graph-4); }
.gn5 { --node-color: var(--git-graph-5); }
.gn6 { --node-color: var(--git-graph-6); }
.gn7 { --node-color: var(--git-graph-7); }
</style>
