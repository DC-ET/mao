<template>
  <div class="pdf-viewer">
    <div class="pdf-toolbar">
      <button class="tool-btn" title="缩小" :disabled="state !== 'ready'" @click="zoomOut">
        <el-icon><ZoomOut /></el-icon>
      </button>
      <button class="tool-btn text" :disabled="state !== 'ready'" @click="fitWidth">适合宽度</button>
      <button class="tool-btn text" :disabled="state !== 'ready'" @click="actualSize">实际大小</button>
      <button class="tool-btn" title="放大" :disabled="state !== 'ready'" @click="zoomIn">
        <el-icon><ZoomIn /></el-icon>
      </button>
      <span class="pdf-page-indicator">{{ state === 'ready' ? `${currentPage} / ${numPages}` : '—' }}</span>
      <button v-if="provider?.downloadFile" class="tool-btn download" title="下载" @click="download">
        <el-icon><Download /></el-icon>
      </button>
    </div>

    <div v-if="state === 'loading'" class="pdf-message">
      <p>正在加载 PDF…{{ loadProgress > 0 ? `（${loadProgress}%）` : '' }}</p>
    </div>

    <div v-else-if="state === 'error'" class="pdf-message error">
      <p>无法预览该 PDF：{{ errorMsg }}</p>
      <button v-if="provider?.downloadFile" class="retry-btn" @click="download">下载后在本地查看</button>
    </div>

    <div v-else ref="scrollContainer" class="pdf-scroll" @scroll="onScroll">
      <div
        v-for="idx in numPages"
        :key="idx"
        :data-page-idx="idx - 1"
        :ref="setPageSlot"
        class="pdf-page-slot"
        :style="pageSlotStyle(idx - 1)"
      >
        <canvas
          v-show="renderedPages.has(idx - 1)"
          :data-page-idx="idx - 1"
          :ref="setCanvas"
          class="pdf-canvas"
        ></canvas>
        <div v-show="!renderedPages.has(idx - 1)" class="pdf-page-placeholder"></div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { Download, ZoomIn, ZoomOut } from '@element-plus/icons-vue'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { WorkspaceFileProvider } from '../../composables/workspace-file-provider'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

// 单页 canvas 像素面积上限（含 devicePixelRatio 放大），防止恶意超大 MediaBox 打崩渲染进程
const MAX_CANVAS_PIXELS = 8192 * 8192

const props = defineProps<{
  blobUrl: string
  filePath: string
  fileName: string
  provider: WorkspaceFileProvider | null
}>()

const state = ref<'loading' | 'ready' | 'error'>('loading')
const errorMsg = ref('')
const loadProgress = ref(0)
const numPages = ref(0)
const currentPage = ref(1)

const scrollContainer = ref<HTMLElement>()
const containerWidth = ref(0)
// DOM 引用用普通数组（避免 reactive 代理 DOM / pdf.js 对象导致私有字段崩溃）
const pageSlots: HTMLElement[] = []
const canvases: HTMLCanvasElement[] = []

// 每页 scale=1 的基础视口尺寸（宽/高），用于 slot 尺寸与渲染比例
const pageBaseSizes = ref<Array<{ width: number; height: number }>>([])

const scaleMode = ref<'fit' | 'custom'>('fit')
const customScale = ref(1)

const cssScale = computed(() => {
  if (scaleMode.value === 'custom') return customScale.value
  const base = pageBaseSizes.value[0]
  if (!containerWidth.value || !base) return 1
  // 左右各留 24px 边距
  return clampScale((containerWidth.value - 48) / base.width)
})

function clampScale(v: number) {
  return Math.max(0.2, Math.min(4, v))
}

function pageSlotStyle(idx: number) {
  const base = pageBaseSizes.value[idx]
  if (!base) return { width: '0px', height: '0px' }
  return {
    width: `${Math.floor(base.width * cssScale.value)}px`,
    height: `${Math.floor(base.height * cssScale.value)}px`,
  }
}

function setPageSlot(el: any) {
  if (!el) return
  const idx = Number(el.dataset.pageIdx)
  pageSlots[idx] = el
}

function setCanvas(el: any) {
  if (!el) return
  const idx = Number(el.dataset.pageIdx)
  canvases[idx] = el
}

// pdf.js 文档对象不可被 Vue 响应式代理（内部大量私有字段），必须用普通变量
let pdfDoc: PDFDocumentProxy | null = null
// Set 内部变更需响应式以驱动模板 v-show（reactive 代理 Set 的内部方法）
const renderedPages = reactive(new Set<number>())
// 渲染任务登记（含 await 前的占位，防并发渲染同一 canvas）；cancel 为 no-op 时表示占位
const renderTasks = new Map<number, { cancel: () => void }>()

let observer: IntersectionObserver | null = null
let resizeObserver: ResizeObserver | null = null
let loadSeq = 0
let hasLoadedOnce = false

function setupObservers() {
  observer?.disconnect()
  resizeObserver?.disconnect()
  observer = null
  resizeObserver = null
  if (!scrollContainer.value) return

  containerWidth.value = scrollContainer.value.clientWidth
  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      containerWidth.value = entry.contentRect.width
    }
  })
  resizeObserver.observe(scrollContainer.value)

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const idx = Number((entry.target as HTMLElement).dataset.pageIdx)
        if (entry.isIntersecting) {
          void renderPage(idx)
        } else {
          cancelRender(idx)
        }
      }
    },
    { root: scrollContainer.value, rootMargin: '200px 0px' },
  )
  for (const slot of pageSlots) {
    if (slot) observer.observe(slot)
  }
}

async function renderPage(idx: number) {
  if (state.value !== 'ready' || !pdfDoc) return
  if (renderedPages.has(idx) || renderTasks.has(idx)) return
  const canvas = canvases[idx]
  const slot = pageSlots[idx]
  if (!canvas || !slot) return

  // await getPage 前登记占位，防止缩放/滚动期间并发渲染同一 canvas
  const placeholder: { cancel: () => void } = { cancel: () => {} }
  renderTasks.set(idx, placeholder)
  try {
    const pdfPage = await pdfDoc.getPage(idx + 1)
    // 已被取消/替换（如缩放、滚动离屏、重新加载）则放弃本次渲染
    if (!slot.isConnected || renderTasks.get(idx) !== placeholder) return
    const base = pageBaseSizes.value[idx]
    const scale = slot.clientWidth / base.width
    const dpr = window.devicePixelRatio || 1
    let viewport = pdfPage.getViewport({ scale: scale * dpr })
    // 页面像素面积超限时按比例缩小渲染，避免 canvas 分配过大内存
    if (viewport.width * viewport.height > MAX_CANVAS_PIXELS) {
      const shrink = Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height))
      viewport = pdfPage.getViewport({ scale: scale * dpr * shrink })
    }
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    canvas.style.width = `${Math.floor(viewport.width / dpr)}px`
    canvas.style.height = `${Math.floor(viewport.height / dpr)}px`
    const renderTask = pdfPage.render({
      canvasContext: canvas.getContext('2d')!,
      viewport,
    })
    renderTasks.set(idx, renderTask)
    await renderTask.promise
    renderTasks.delete(idx)
    renderedPages.add(idx)
  } catch (e: any) {
    renderTasks.delete(idx)
    // 缩放/滚动导致的主动取消属正常流程
    if (e?.name !== 'RenderingCancelledException') {
      console.warn(`[pdf] render page ${idx + 1} failed`, e)
    }
  }
}

function cancelRender(idx: number) {
  const task = renderTasks.get(idx)
  if (task) {
    task.cancel()
    renderTasks.delete(idx)
  }
}

function cancelAllRenders() {
  for (const idx of renderTasks.keys()) {
    cancelRender(idx)
  }
}

function onScroll() {
  const container = scrollContainer.value
  if (!container) return
  const containerTop = container.getBoundingClientRect().top
  const threshold = container.scrollTop + 50
  for (let i = 0; i < pageSlots.length; i++) {
    const slot = pageSlots[i]
    if (!slot?.isConnected) continue
    // 与容器滚动坐标对齐（getBoundingClientRect 相对视口，换算到容器坐标系）
    const slotTop = slot.getBoundingClientRect().top - containerTop + container.scrollTop
    if (slotTop + slot.offsetHeight > threshold) {
      currentPage.value = i + 1
      break
    }
  }
}

function fitWidth() {
  scaleMode.value = 'fit'
}

function actualSize() {
  scaleMode.value = 'custom'
  customScale.value = 1
}

function zoomIn() {
  scaleMode.value = 'custom'
  customScale.value = clampScale(customScale.value * 1.25)
}

function zoomOut() {
  scaleMode.value = 'custom'
  customScale.value = clampScale(customScale.value / 1.25)
}

function download() {
  // 下载需用完整相对路径（子目录 PDF 才能命中），文件名仅作建议名
  if (props.provider?.downloadFile) {
    void props.provider.downloadFile(props.filePath, props.fileName)
  }
}

async function loadPdf() {
  const seq = ++loadSeq
  state.value = 'loading'
  loadProgress.value = 0
  numPages.value = 0
  pageBaseSizes.value = []
  pageSlots.length = 0
  canvases.length = 0
  renderedPages.clear()
  cancelAllRenders()
  pdfDoc?.destroy()
  pdfDoc = null

  try {
    const loadingTask = pdfjsLib.getDocument({
      url: props.blobUrl,
      isEvalSupported: false,
    })
    loadingTask.onProgress = (data: { loaded: number; total: number }) => {
      if (data.total && data.total > 0) {
        loadProgress.value = Math.min(99, Math.round((data.loaded / data.total) * 100))
      }
    }
    const doc = await loadingTask.promise
    if (seq !== loadSeq) {
      doc.destroy()
      return
    }
    pdfDoc = doc
    numPages.value = doc.numPages

    // 预取每页基础尺寸（scale=1），用于 slot 布局
    const sizes: Array<{ width: number; height: number }> = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      if (seq !== loadSeq) {
        doc.destroy()
        return
      }
      const vp = page.getViewport({ scale: 1 })
      sizes.push({ width: vp.width, height: vp.height })
    }
    pageBaseSizes.value = sizes
    loadProgress.value = 100
    state.value = 'ready'
    await nextTick()
    setupObservers()
  } catch (e: any) {
    if (seq !== loadSeq) return
    pdfDoc?.destroy()
    pdfDoc = null
    state.value = 'error'
    errorMsg.value = e?.message || '文件已损坏或格式不受支持'
  }
}

watch(() => props.blobUrl, () => {
  void loadPdf()
})

watch(cssScale, () => {
  // 缩放变化：slot 尺寸随 style 绑定自动更新，重渲染可视页
  cancelAllRenders()
  renderedPages.clear()
  for (const slot of pageSlots) {
    const idx = slot?.dataset.pageIdx
    if (idx !== undefined && slot?.isConnected && isSlotVisible(slot)) {
      void renderPage(Number(idx))
    }
  }
})

function isSlotVisible(el: HTMLElement): boolean {
  const container = scrollContainer.value
  if (!container) return false
  const cRect = container.getBoundingClientRect()
  const rect = el.getBoundingClientRect()
  return rect.bottom >= cRect.top - 200 && rect.top <= cRect.bottom + 200
}

onMounted(() => {
  void loadPdf()
})

onActivated(() => {
  // 首次挂载由 onMounted 加载；keep-alive 缓存后重新激活时文档已被 deactivate 销毁，需重载
  if (hasLoadedOnce) {
    void loadPdf()
  }
  hasLoadedOnce = true
})

onDeactivated(() => {
  // 标签切换仅 deactivate 不卸载：释放渲染任务与文档，避免多份 PDF 常驻内存
  loadSeq++
  observer?.disconnect()
  resizeObserver?.disconnect()
  observer = null
  resizeObserver = null
  cancelAllRenders()
  pdfDoc?.destroy()
  pdfDoc = null
})

onUnmounted(() => {
  loadSeq++
  observer?.disconnect()
  resizeObserver?.disconnect()
  observer = null
  resizeObserver = null
  cancelAllRenders()
  pdfDoc?.destroy()
  pdfDoc = null
})
</script>

<style scoped>
.pdf-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--aw-canvas-parchment);
}

.pdf-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--aw-divider-soft);
  background: var(--aw-surface);
  flex-shrink: 0;
}

.tool-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
  background: none;
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-xs);
  cursor: pointer;
  transition: all 0.15s;
}

.tool-btn:hover:not(:disabled) {
  color: var(--aw-ink);
  border-color: var(--aw-ink-muted-48);
}

.tool-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.tool-btn.text {
  padding: 4px 10px;
}

.tool-btn.download {
  margin-left: auto;
  color: var(--aw-primary);
  border-color: var(--aw-primary);
}

.tool-btn.download:hover:not(:disabled) {
  background: rgba(0, 102, 204, 0.08);
}

.pdf-page-indicator {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
  margin-left: 4px;
}

.pdf-scroll {
  flex: 1;
  overflow: auto;
  padding: 12px 24px 24px;
}

.pdf-page-slot {
  margin: 0 auto 12px;
  position: relative;
  background: var(--aw-surface);
  border: 1px solid var(--aw-hairline);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

.pdf-page-slot:last-child {
  margin-bottom: 0;
}

.pdf-canvas {
  display: block;
  margin: 0 auto;
}

.pdf-page-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-fine);
}

.pdf-message {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-body);
}

.pdf-message.error p {
  color: var(--aw-danger);
}

.pdf-message p {
  margin: 0;
}

.retry-btn {
  font-size: var(--aw-text-caption);
  color: var(--aw-primary);
  background: none;
  border: 1px solid var(--aw-primary);
  border-radius: var(--aw-radius-xs);
  padding: 4px 16px;
  cursor: pointer;
}

.retry-btn:hover {
  background: rgba(0, 102, 204, 0.08);
}

.pdf-scroll::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.pdf-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.pdf-scroll::-webkit-scrollbar-thumb {
  background: var(--aw-hairline);
  border-radius: 4px;
}

/* Dark mode */
[data-theme="dark"] .pdf-page-slot {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}
</style>
