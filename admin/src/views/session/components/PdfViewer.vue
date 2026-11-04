<template>
  <!--
    PDF 预览：pdf.js 自渲染成 canvas，不依赖宿主浏览器的原生 PDF 能力。

    历史问题（2026-11-04 线上）：早期用 <iframe :src="blobUrl">，桌面 Chrome 正常，
    但微信内置 WebView（iOS WKWebView / Android X5）对 blob URL 的原生 PDF 渲染支持
    不完整，表现为 iframe 整块白屏且无任何错误提示。改为 pdf.js 栅格化后与 desktop 端
    同口径，全平台一致；加载失败仍有明确错误态，不再静默白屏。
  -->
  <div class="apdf">
    <div class="apdf-toolbar">
      <el-button-group>
        <el-button size="small" :disabled="state !== 'ready'" @click="zoomOut" title="缩小">
          <el-icon><ZoomOut /></el-icon>
        </el-button>
        <el-button size="small" :disabled="state !== 'ready'" @click="fitWidth" title="适合宽度">适合宽度</el-button>
        <el-button size="small" :disabled="state !== 'ready'" @click="actualSize" title="实际大小">实际大小</el-button>
        <el-button size="small" :disabled="state !== 'ready'" @click="zoomIn" title="放大">
          <el-icon><ZoomIn /></el-icon>
        </el-button>
      </el-button-group>
      <span class="apdf-indicator">
        {{ state === 'ready' ? `${currentPage} / ${numPages} 页` : '—' }}
      </span>
    </div>

    <div v-if="state === 'loading'" class="apdf-message">
      <el-icon class="apdf-spin"><Loading /></el-icon>
      <span>正在加载 PDF…{{ loadProgress > 0 ? `（${loadProgress}%）` : '' }}</span>
    </div>

    <div v-else-if="state === 'error'" class="apdf-message is-error">
      <el-icon><WarningFilled /></el-icon>
      <span class="apdf-error-text">无法预览该 PDF：{{ errorMsg }}</span>
      <span class="apdf-error-hint">可点击右上角「下载」后在本地查看</span>
    </div>

    <div v-else ref="scrollContainer" class="apdf-scroll" @scroll="onScroll">
      <div
        v-for="idx in numPages"
        :key="idx"
        :data-page-idx="idx - 1"
        :ref="setPageSlot"
        class="apdf-slot"
        :style="pageSlotStyle(idx - 1)"
      >
        <canvas
          v-show="renderedPages.has(idx - 1)"
          :data-page-idx="idx - 1"
          :ref="setCanvas"
          class="apdf-canvas"
        ></canvas>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { Loading, WarningFilled, ZoomIn, ZoomOut } from '@element-plus/icons-vue'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

// 单页 canvas 像素面积上限（含 devicePixelRatio 放大），防止恶意超大 MediaBox 打崩页面
const MAX_CANVAS_PIXELS = 8192 * 8192

const props = defineProps<{
  blobUrl: string
  fileName: string
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

// 每页 scale=1 的基础视口尺寸（宽/高），用于 slot 布局与渲染比例
const pageBaseSizes = ref<Array<{ width: number; height: number }>>([])

const scaleMode = ref<'fit' | 'custom'>('fit')
const customScale = ref(1)

const cssScale = computed(() => {
  if (scaleMode.value === 'custom') return customScale.value
  const base = pageBaseSizes.value[0]
  if (!containerWidth.value || !base) return 1
  // 左右各留 16px 边距
  return clampScale((containerWidth.value - 32) / base.width)
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

function setPageSlot(el: unknown) {
  const node = el as HTMLElement | null
  if (!node) return
  pageSlots[Number(node.dataset.pageIdx)] = node
}

function setCanvas(el: unknown) {
  const node = el as HTMLCanvasElement | null
  if (!node) return
  canvases[Number(node.dataset.pageIdx)] = node
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
  } catch (e: unknown) {
    renderTasks.delete(idx)
    // 缩放/滚动导致的主动取消属正常流程
    if ((e as { name?: string })?.name !== 'RenderingCancelledException') {
      console.warn(`[admin-pdf] render page ${idx + 1} failed`, e)
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

async function loadPdf() {
  const seq = ++loadSeq
  state.value = 'loading'
  loadProgress.value = 0
  numPages.value = 0
  currentPage.value = 1
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

    // 预取每页基础尺寸（scale=1），用于 slot 布局；分批并发，避免大文档串行等待或一次发出全部请求
    const sizes: Array<{ width: number; height: number }> = []
    const PREFETCH_BATCH_SIZE = 20
    for (let start = 1; start <= doc.numPages; start += PREFETCH_BATCH_SIZE) {
      const end = Math.min(start + PREFETCH_BATCH_SIZE - 1, doc.numPages)
      const pages = await Promise.all(
        Array.from({ length: end - start + 1 }, (_, k) => doc.getPage(start + k)),
      )
      if (seq !== loadSeq) {
        doc.destroy()
        return
      }
      for (const page of pages) {
        const vp = page.getViewport({ scale: 1 })
        sizes.push({ width: vp.width, height: vp.height })
      }
    }
    pageBaseSizes.value = sizes
    loadProgress.value = 100
    state.value = 'ready'
    await nextTick()
    setupObservers()
  } catch (e: unknown) {
    if (seq !== loadSeq) return
    pdfDoc?.destroy()
    pdfDoc = null
    state.value = 'error'
    errorMsg.value = (e as { message?: string })?.message || '文件已损坏或格式不受支持'
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
.apdf {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}

.apdf-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 8px;
  flex-shrink: 0;
}

.apdf-indicator {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.apdf-message {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 240px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.apdf-message.is-error {
  color: var(--el-color-danger);
}

.apdf-spin {
  animation: apdf-rotate 1s linear infinite;
}

@keyframes apdf-rotate {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.apdf-error-text {
  font-size: 13px;
}

.apdf-error-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.apdf-scroll {
  flex: 1;
  min-height: 240px;
  overflow: auto;
  padding: 0 4px 8px;
}

.apdf-slot {
  margin: 0 auto 10px;
  position: relative;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  overflow: hidden;
}

.apdf-slot:last-child {
  margin-bottom: 0;
}

.apdf-canvas {
  display: block;
  margin: 0 auto;
}
</style>
