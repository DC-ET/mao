<template>
  <el-dialog
    :model-value="true"
    fullscreen
    append-to-body
    destroy-on-close
    :show-close="false"
    class="image-annotator-dialog"
    @update:model-value="$emit('update:visible', $event)"
    @opened="init"
  >
    <template #header>
      <div class="annotator-header">
        <span class="annotator-title">标注图片 - {{ file.name }}</span>
        <div class="annotator-toolbar" role="toolbar" aria-label="标注工具">
          <button
            v-for="def in TOOL_DEFS"
            :key="def.tool"
            type="button"
            class="annotator-tool-btn is-icon"
            :class="{ active: tool === def.tool }"
            :aria-pressed="tool === def.tool"
            :aria-label="def.label"
            :title="def.label"
            @click="selectTool(def.tool)"
          >
            <svg class="annotator-tool-icon" viewBox="0 0 24 24" aria-hidden="true">
              <g v-if="def.tool === 'pen'" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 20.5l4.4-1.2L19.2 8.5a2 2 0 0 0 0-2.8l-1.4-1.4a2 2 0 0 0-2.8 0L4.2 15.1 4 20.5z" />
                <path d="M13.2 5.6l5.2 5.2" />
              </g>
              <g v-else-if="def.tool === 'rect'" fill="none" stroke="currentColor" stroke-width="1.7">
                <rect x="4.5" y="6.5" width="15" height="11" rx="1.5" />
              </g>
              <g v-else-if="def.tool === 'arrow'" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 19L19 5" />
                <path d="M10 5h9v9" />
              </g>
              <g v-else-if="def.tool === 'text'" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
                <path d="M5 6h14" />
                <path d="M12 6v13" />
              </g>
              <g v-else fill="currentColor">
                <rect x="4" y="4" width="6.5" height="6.5" rx="1" />
                <rect x="13.5" y="4" width="6.5" height="6.5" rx="1" opacity="0.35" />
                <rect x="4" y="13.5" width="6.5" height="6.5" rx="1" opacity="0.35" />
                <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1" />
              </g>
            </svg>
          </button>
          <button
            type="button"
            class="annotator-tool-btn"
            :aria-label="`撤销（剩 ${ops.length} 步）`"
            :title="`撤销（剩 ${ops.length} 步）`"
            :disabled="ops.length === 0"
            @click="undo"
          >撤销</button>
        </div>
      </div>
    </template>

    <div ref="viewportEl" class="annotator-viewport">
      <div class="annotator-stack" :style="stackStyle">
        <canvas ref="baseCanvas" :width="size.width" :height="size.height" class="annotator-base"></canvas>
        <canvas
          ref="drawCanvas"
          :width="size.width"
          :height="size.height"
          class="annotator-draw"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        />
        <input
          v-if="textDraft"
          ref="textInput"
          v-model="textDraft.value"
          class="annotator-text-input"
          :style="textInputStyle"
          aria-label="标注文字"
          placeholder="输入文字，Enter 确认"
          @keydown.enter.stop.prevent="commitText"
          @keydown.esc.stop.prevent="cancelText"
          @blur="commitText"
        />
      </div>
    </div>

    <template #footer>
      <div class="annotator-footer">
        <span class="annotator-hint">标注只影响本次发送的图片副本，原图保留可再次标注</span>
        <div class="annotator-actions">
          <el-button :disabled="exporting" @click="$emit('update:visible', false)">取消</el-button>
          <el-button type="primary" :loading="exporting" @click="confirmExport">确认标注</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  ANNOTATE_COLOR,
  ANNOTATE_FONT_SIZE,
  ANNOTATE_LINE_WIDTH,
  MOSAIC_DEFAULT_RADIUS,
  applyMosaic,
  canvasPointFromClient,
  drawOp,
  fitDisplaySize,
  fitImageSize,
  type AnnotateOp,
  type AnnotateTool,
} from '../../utils/image-annotate'

const props = defineProps<{ file: File }>()
// update:visible(false) = 关闭（父级 v-if 摘除）；confirm(file) = 用标注产物替换待发附件
const emit = defineEmits<{
  confirm: [file: File]
  'update:visible': [value: boolean]
}>()

const TOOL_DEFS: Array<{ tool: AnnotateTool; label: string }> = [
  { tool: 'pen', label: '画笔' },
  { tool: 'rect', label: '矩形' },
  { tool: 'arrow', label: '箭头' },
  { tool: 'text', label: '文字' },
  { tool: 'mosaic', label: '马赛克' },
]

const tool = ref<AnnotateTool>('pen')
const ops = ref<AnnotateOp[]>([])
const size = ref({ width: 0, height: 0 })
/** CSS 显示盒子。位图保持原图分辨率，屏幕上整图缩进视口。 */
const display = ref({ width: 0, height: 0 })
const viewportEl = ref<HTMLElement>()
const baseCanvas = ref<HTMLCanvasElement>()
const drawCanvas = ref<HTMLCanvasElement>()
const textDraft = ref<{ x: number; y: number; value: string } | null>(null)
const exporting = ref(false)
let resizeObserver: ResizeObserver | null = null
let imageUrl: string | null = null
// 在途笔画：pen/mosaic 累积 points，rect/arrow 记起止；pointerup 落栈
let drawing: { points?: Array<{ x: number; y: number }>; x0?: number; y0?: number; x1?: number; y1?: number; stamped?: number } | null = null
// 已提交 ops 的离屏快照（commit/undo/切工具时重建）：preview 每帧只叠在途 op，成本 O(1)
let committed: HTMLCanvasElement | null = null
let committedCtx: CanvasRenderingContext2D | null = null
let previewScheduled = false

const stackStyle = computed(() => ({ width: `${display.value.width}px`, height: `${display.value.height}px` }))
const textInputStyle = computed(() => {
  const draft = textDraft.value
  if (!draft || size.value.width <= 0 || display.value.width <= 0) return {}
  const sx = display.value.width / size.value.width
  const sy = display.value.height / size.value.height
  return {
    left: `${draft.x * sx}px`,
    top: `${draft.y * sy}px`,
    fontSize: `${Math.max(16, ANNOTATE_FONT_SIZE * sy)}px`,
  }
})

/** 视口内容盒（去掉 padding），供整图适配。对话框动画未结束时可能是 0。 */
function viewportAvail(): { width: number; height: number } | null {
  const vp = viewportEl.value
  if (!vp) return null
  const style = getComputedStyle(vp)
  const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
  const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
  return { width: vp.clientWidth - padX, height: vp.clientHeight - padY }
}

function updateDisplaySize() {
  const box = viewportAvail()
  if (!box || size.value.width <= 0 || size.value.height <= 0) return
  if (box.width < 2 || box.height < 2) return
  const next = fitDisplaySize(size.value.width, size.value.height, box.width, box.height)
  if (next.width === display.value.width && next.height === display.value.height) return
  display.value = next
}

function bindViewportObserver() {
  resizeObserver?.disconnect()
  const vp = viewportEl.value
  if (!vp || typeof ResizeObserver === 'undefined') return
  resizeObserver = new ResizeObserver(() => updateDisplaySize())
  resizeObserver.observe(vp)
}

const baseCtx = () => baseCanvas.value?.getContext('2d') ?? null
const drawCtx = () => drawCanvas.value?.getContext('2d') ?? null

/** 加载原图绘入底层画布（>4096 边等比缩放）；blob 同源无 taint，绘制完成即回收 objectURL。 */
async function init() {
  imageUrl = URL.createObjectURL(props.file)
  const img = new Image()
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('图片加载失败'))
      img.src = imageUrl!
    })
  } catch (e) {
    ElMessage.error((e as Error).message || '图片加载失败')
    emit('update:visible', false)
    return
  }
  size.value = fitImageSize(img.naturalWidth, img.naturalHeight)
  ops.value = []
  bindViewportObserver()
  await nextTick()
  updateDisplaySize()
  // 首帧页眉/页脚换行后视口会变矮，再量一次，避免底栏被挤出屏幕
  requestAnimationFrame(() => updateDisplaySize())
  baseCtx()?.drawImage(img, 0, 0, size.value.width, size.value.height)
  committed = document.createElement('canvas')
  committed.width = size.value.width
  committed.height = size.value.height
  committedCtx = committed.getContext('2d')
  URL.revokeObjectURL(imageUrl!)
  imageUrl = null
}

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  if (imageUrl) URL.revokeObjectURL(imageUrl)
})

function selectTool(next: AnnotateTool) {
  tool.value = next
  // 切工具丢弃在途笔画（半截矩形/箭头没有意义）
  drawing = null
  rebuildCommitted()
  preview()
}

function undo() {
  if (ops.value.length === 0) return
  ops.value.pop()
  rebuildCommitted()
  preview()
}

/** 已提交 ops 重放进离屏快照（马赛克只读底图、逐点幂等，重放确定性由单测锁定）。 */
function rebuildCommitted() {
  const bc = baseCtx()
  if (!committed || !committedCtx || !bc) return
  committedCtx.clearRect(0, 0, committed.width, committed.height)
  for (const op of ops.value) {
    if (op.tool === 'mosaic') applyMosaic(bc, committedCtx, op)
    else drawOp(committedCtx, op)
  }
}

function canvasPoint(e: PointerEvent): { x: number; y: number } {
  const canvas = drawCanvas.value!
  const rect = canvas.getBoundingClientRect()
  return canvasPointFromClient(e.clientX, e.clientY, rect, { width: canvas.width, height: canvas.height })
}

function onPointerDown(e: PointerEvent) {
  if (exporting.value) return
  const p = canvasPoint(e)
  if (tool.value === 'text') {
    // 文字：点击定位输入框，Enter/失焦落笔
    textDraft.value = { x: p.x, y: p.y, value: '' }
    void nextTick(() => {
      ;(document.querySelector('.annotator-text-input') as HTMLInputElement | null)?.focus()
    })
    return
  }
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  if (tool.value === 'pen' || tool.value === 'mosaic') {
    drawing = { points: [p] }
  } else {
    drawing = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }
  }
}

function onPointerMove(e: PointerEvent) {
  if (!drawing) return
  const p = canvasPoint(e)
  if (drawing.points) {
    drawing.points.push(p)
    if (tool.value === 'mosaic') {
      // 马赛克增量盖章（只盖新点，避免整笔逐帧重跑全部 getImageData 的 O(n²)）
      const bc = baseCtx()
      const dc = drawCtx()
      if (!bc || !dc) return
      const stamped = drawing.stamped ?? 0
      for (let i = stamped; i < drawing.points.length; i++) {
        applyMosaic(bc, dc, { tool: 'mosaic', color: ANNOTATE_COLOR, width: ANNOTATE_LINE_WIDTH, points: [drawing.points[i]], radius: MOSAIC_DEFAULT_RADIUS })
      }
      drawing.stamped = drawing.points.length
      return
    }
  } else {
    drawing.x1 = p.x
    drawing.y1 = p.y
  }
  schedulePreview()
}

function onPointerUp() {
  if (!drawing) return
  const op = opFromDrawing()
  // 无效笔画过滤：pen 单点不成线；rect/arrow 拖拽距离过小视为误触
  const isStroke = op.points ? op.points.length >= (op.tool === 'pen' ? 2 : 1) : Math.abs((op.x1 ?? 0) - (op.x0 ?? 0)) > 2 || Math.abs((op.y1 ?? 0) - (op.y0 ?? 0)) > 2
  if (isStroke) ops.value.push(op)
  drawing = null
  rebuildCommitted()
  preview()
}

function opFromDrawing(): AnnotateOp {
  const common = { color: ANNOTATE_COLOR, width: ANNOTATE_LINE_WIDTH }
  if (drawing!.points) {
    return { tool: tool.value as 'pen' | 'mosaic', points: [...drawing!.points], radius: MOSAIC_DEFAULT_RADIUS, ...common }
  }
  return { tool: tool.value as 'rect' | 'arrow', x0: drawing!.x0, y0: drawing!.y0, x1: drawing!.x1, y1: drawing!.y1, ...common }
}

/** preview = 离屏快照 + 在途 op（pointermove 经 rAF 合并，每帧至多一次全量重绘）。 */
function preview() {
  const dc = drawCtx()
  if (!dc || !committed) return
  dc.clearRect(0, 0, dc.canvas.width, dc.canvas.height)
  dc.drawImage(committed, 0, 0)
  if (drawing) {
    const op = opFromDrawing()
    if (op.tool !== 'mosaic') drawOp(dc, op)
  }
}

function schedulePreview() {
  if (previewScheduled) return
  previewScheduled = true
  requestAnimationFrame(() => {
    previewScheduled = false
    preview()
  })
}

function commitText() {
  const draft = textDraft.value
  if (!draft) return
  textDraft.value = null
  if (draft.value.trim() === '') return
  ops.value.push({ tool: 'text', x: draft.x, y: draft.y, text: draft.value, color: ANNOTATE_COLOR, width: ANNOTATE_LINE_WIDTH, fontSize: ANNOTATE_FONT_SIZE })
  rebuildCommitted()
  preview()
}

function cancelText() {
  textDraft.value = null
}

async function confirmExport() {
  if (exporting.value) return
  exporting.value = true
  try {
    // 文字输入未落笔时先提交（避免丢字）
    commitText()
    const out = document.createElement('canvas')
    out.width = size.value.width
    out.height = size.value.height
    const octx = out.getContext('2d')!
    octx.drawImage(baseCanvas.value!, 0, 0)
    octx.drawImage(drawCanvas.value!, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('导出失败')
    const baseName = props.file.name.replace(/\.[^.]+$/, '')
    emit('confirm', new File([blob], `${baseName}-annotated.png`, { type: 'image/png' }))
  } catch (e) {
    ElMessage.error((e as Error).message || '标注导出失败')
  } finally {
    exporting.value = false
  }
}
</script>

<style scoped>
.annotator-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}

.annotator-title {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.annotator-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  flex: none;
  max-width: 100%;
}

.annotator-tool-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--aw-hairline);
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink);
  font-size: var(--aw-text-caption);
  padding: 4px 12px;
  border-radius: var(--aw-radius-sm);
  cursor: pointer;
  flex: none;
}

.annotator-tool-btn.is-icon {
  width: 32px;
  height: 32px;
  padding: 0;
}

.annotator-tool-icon {
  width: 18px;
  height: 18px;
  display: block;
}

.annotator-tool-btn:hover {
  color: var(--aw-primary);
}

.annotator-tool-btn.active {
  border-color: var(--aw-primary);
  color: var(--aw-primary);
  background: color-mix(in srgb, var(--aw-primary) 10%, var(--aw-canvas-parchment));
}

.annotator-tool-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.annotator-viewport {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  box-sizing: border-box;
  padding: 8px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--aw-canvas);
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-sm);
}

.annotator-stack {
  position: relative;
  flex: none;
}

.annotator-base,
.annotator-draw {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
}

.annotator-draw {
  cursor: crosshair;
  touch-action: none;
}

.annotator-text-input {
  position: absolute;
  min-width: 120px;
  font-size: 16px;
  color: var(--aw-ink);
  background: var(--aw-surface-code);
  border: 1px dashed var(--aw-primary);
  border-radius: 4px;
  padding: 2px 4px;
  outline: none;
}

.annotator-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
}

.annotator-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex: none;
}

.annotator-hint {
  flex: 1;
  min-width: 0;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  line-height: 1.4;
  overflow-wrap: anywhere;
}

@media (max-width: 640px) {
  .annotator-header {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }

  .annotator-toolbar {
    justify-content: flex-start;
  }

  .annotator-footer {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }

  .annotator-hint,
  .annotator-actions {
    flex: none;
    width: 100%;
  }
}

@media (pointer: coarse) {
  .annotator-tool-btn.is-icon {
    width: 40px;
    height: 40px;
  }

  .annotator-tool-icon {
    width: 20px;
    height: 20px;
  }

  .annotator-tool-btn:not(.is-icon) {
    min-height: 40px;
  }
}
</style>

<style>
/* ElDialog teleport 到 body，壳层样式不能写在 scoped 里。 */
.el-overlay-dialog:has(.image-annotator-dialog) {
  overflow: hidden;
}

.image-annotator-dialog.el-dialog.is-fullscreen {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  width: auto;
  height: auto;
  max-height: none;
  margin: 0;
  overflow: hidden;
  box-sizing: border-box;
}

.image-annotator-dialog .el-dialog__header,
.image-annotator-dialog .el-dialog__footer {
  flex: none;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
}

.image-annotator-dialog .el-dialog__body {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  width: 100%;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

@media (max-width: 640px) {
  .image-annotator-dialog.el-dialog.is-fullscreen {
    --el-dialog-padding-primary: 10px;
    padding: 10px;
  }
}
</style>
