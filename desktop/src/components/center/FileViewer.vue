<template>
  <div class="file-viewer" v-loading="state === 'loading'">
    <!-- Error state -->
    <div v-if="state === 'error'" class="file-message error">
      <p>文件读取失败：{{ errorMsg }}</p>
      <div class="file-message-actions">
        <button type="button" class="retry-btn" @click="loadFile">重试</button>
        <button v-if="provider?.downloadFile" type="button" class="retry-btn primary" @click="downloadFile">
          <el-icon :size="13"><Download /></el-icon>
          <span>下载文件</span>
        </button>
        <button v-else-if="canShowInFinder" type="button" class="retry-btn" @click="showInFinder">在 Finder 中显示</button>
      </div>
    </div>

    <!-- Image preview -->
    <div v-else-if="state === 'image'" class="file-message image-preview">
      <div class="viewer-toolbar" role="toolbar" aria-label="文件操作">
        <button v-if="!isDelivery" type="button" class="tool-btn" title="引用到对话" aria-label="引用到对话" @click="emit('add-file-to-chat', props.filePath)">
          <el-icon :size="14"><ChatDotRound /></el-icon>
        </button>
        <button v-if="provider?.downloadFile" type="button" class="tool-btn" title="下载文件" aria-label="下载文件" @click="downloadFile">
          <el-icon :size="14"><Download /></el-icon>
        </button>
        <button type="button" class="tool-btn" title="刷新" aria-label="刷新" @click="loadFile">
          <el-icon :size="14"><Refresh /></el-icon>
        </button>
      </div>
      <img :src="imageDataUri" :alt="filePath" />
      <p class="image-meta">{{ content }}</p>
    </div>

    <!-- PDF preview -->
    <div v-else-if="state === 'pdf' && pdfBlobUrl" class="pdf-container">
      <PdfViewer
        :blob-url="pdfBlobUrl"
        :file-path="props.filePath"
        :file-name="pdfFileName"
        :provider="provider"
      />
    </div>

    <!-- CSV / TSV table view -->
    <div v-else-if="state === 'csv'" class="file-content">
      <CsvTableView
        :file-path="props.filePath"
        :content="content"
        :truncated="truncated"
        :provider="provider"
        @refresh="loadFile"
      />
    </div>

    <!-- ZIP / TAR / TAR.GZ archive browser -->
    <div v-else-if="state === 'zip' && bytesData" class="file-content">
      <ArchiveBrowser
        :file-path="props.filePath"
        :file-name="bytesData.name"
        :bytes="bytesData.bytes"
        :provider="provider"
        @refresh="loadFile"
      />
    </div>

    <!-- XLSX spreadsheet view -->
    <div v-else-if="state === 'xlsx' && bytesData" class="file-content">
      <SpreadsheetView
        :file-path="props.filePath"
        :bytes="bytesData.bytes"
        :provider="provider"
        @refresh="loadFile"
      />
    </div>

    <!-- DOCX document preview -->
    <div v-else-if="state === 'docx' && bytesData" class="file-content">
      <DocxPreview
        :file-path="props.filePath"
        :bytes="bytesData.bytes"
        :provider="provider"
        @refresh="loadFile"
      />
    </div>

    <!-- Audio / video player -->
    <div v-else-if="state === 'media' && bytesData" class="file-content">
      <MediaPlayer
        :file-path="props.filePath"
        :bytes="bytesData.bytes"
        :provider="provider"
        @refresh="loadFile"
      />
    </div>

    <!-- Binary file -->
    <div v-else-if="state === 'binary'" class="file-message binary-preview">
      <div class="viewer-toolbar" role="toolbar" aria-label="文件操作">
        <button v-if="!isDelivery" type="button" class="tool-btn" title="引用到对话" aria-label="引用到对话" @click="emit('add-file-to-chat', props.filePath)">
          <el-icon :size="14"><ChatDotRound /></el-icon>
        </button>
        <button v-if="provider?.downloadFile" type="button" class="tool-btn" title="下载文件" aria-label="下载文件" @click="downloadFile">
          <el-icon :size="14"><Download /></el-icon>
        </button>
        <button type="button" class="tool-btn" title="刷新" aria-label="刷新" @click="loadFile">
          <el-icon :size="14"><Refresh /></el-icon>
        </button>
      </div>
      <p>二进制文件，无法预览</p>
      <div class="file-message-actions">
        <button v-if="provider?.downloadFile" type="button" class="retry-btn primary" @click="downloadFile">
          <el-icon :size="13"><Download /></el-icon>
          <span>下载文件</span>
        </button>
        <button v-else-if="canShowInFinder" type="button" class="retry-btn" @click="showInFinder">在 Finder 中显示</button>
      </div>
    </div>

    <!-- Empty file -->
    <div v-else-if="state === 'empty'" class="file-message empty-preview">
      <div class="viewer-toolbar" role="toolbar" aria-label="文件操作">
        <button v-if="!isDelivery" type="button" class="tool-btn" title="引用到对话" aria-label="引用到对话" @click="emit('add-file-to-chat', props.filePath)">
          <el-icon :size="14"><ChatDotRound /></el-icon>
        </button>
        <button v-if="provider?.downloadFile" type="button" class="tool-btn" title="下载文件" aria-label="下载文件" @click="downloadFile">
          <el-icon :size="14"><Download /></el-icon>
        </button>
        <button type="button" class="tool-btn" title="刷新" aria-label="刷新" @click="loadFile">
          <el-icon :size="14"><Refresh /></el-icon>
        </button>
      </div>
      <p>空文件</p>
    </div>

    <!-- Content -->
    <div v-else-if="state === 'ready'" class="file-content">
      <div class="viewer-toolbar" role="toolbar" aria-label="文件操作">
        <div v-if="isMarkdown" class="view-switch" role="group" aria-label="预览与源码">
          <button
            type="button"
            :class="['tool-btn', { active: viewMode === 'rendered' }]"
            :aria-pressed="viewMode === 'rendered'"
            title="预览"
            aria-label="预览"
            @click="viewMode = 'rendered'"
          >
            <el-icon :size="14"><View /></el-icon>
          </button>
          <button
            type="button"
            :class="['tool-btn', { active: viewMode === 'source' }]"
            :aria-pressed="viewMode === 'source'"
            title="源码"
            aria-label="源码"
            @click="viewMode = 'source'"
          >
            <svg class="tool-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5.2 3.2 2.2 8l3 4.8M10.8 3.2 13.8 8l-3 4.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>
        <button
          v-if="showSource"
          type="button"
          :class="['tool-btn', { active: wordWrapOn }]"
          :aria-pressed="wordWrapOn"
          title="自动换行"
          aria-label="自动换行"
          @click="toggleWordWrap"
        >
          <svg class="tool-icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2.5 3.5h11M2.5 8h7.2a2.2 2.2 0 0 1 0 4.4H6.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            <path d="M4.6 10.6 6.2 12.4 4.6 14.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button type="button" class="tool-btn" title="复制全文" aria-label="复制全文" @click="copyAll">
          <el-icon :size="14"><CopyDocument /></el-icon>
        </button>
        <button v-if="!isDelivery" type="button" class="tool-btn" title="引用到对话" aria-label="引用到对话" @click="emit('add-file-to-chat', props.filePath)">
          <el-icon :size="14"><ChatDotRound /></el-icon>
        </button>
        <button v-if="provider?.downloadFile" type="button" class="tool-btn" title="下载文件" aria-label="下载文件" @click="downloadFile">
          <el-icon :size="14"><Download /></el-icon>
        </button>
        <button type="button" class="tool-btn" title="刷新" aria-label="刷新" @click="loadFile">
          <el-icon :size="14"><Refresh /></el-icon>
        </button>
      </div>
      <div class="file-editor-area">
        <div
          v-show="showSource"
          ref="monacoContainer"
          class="monaco-container"
        ></div>
        <div v-show="!showSource" class="file-scroll" @click="handleMarkdownClick">
          <MarkdownContent :content="content" body-class="markdown-body" />
        </div>
      </div>
      <div v-if="truncated" class="truncation-notice">
        仅显示前 5000 行
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, toRef, inject } from 'vue'
import { useMonacoViewer } from '../../composables/useMonacoViewer'
import { attachMonacoQuote } from '../../composables/useMonacoQuote'
import { useShowInFinder } from '../../composables/useShowInFinder'
import type { FileRangeQuotePayload } from '../../utils/selection-quote'
import { isAndroidCapacitor, openExternalUrl } from '../../utils/capacitor'
import { isWechatBrowser } from '../../utils/user-agent'
import MarkdownContent from '../common/MarkdownContent.vue'
import PdfViewer from './PdfViewer.vue'
import CsvTableView from './CsvTableView.vue'
import ArchiveBrowser from './ArchiveBrowser.vue'
import SpreadsheetView from './SpreadsheetView.vue'
import DocxPreview from './DocxPreview.vue'
import MediaPlayer from './MediaPlayer.vue'
import { useCenterTabs } from '../../composables/useCenterTabs'
import { useSessionStore } from '../../stores/session'
import { useTheme } from '../../utils/theme'
import { isExternalMarkdownLink, resolveMarkdownLink } from '../../utils/markdown-link'
import { resolvePreviewKind, sniffContainerKind } from '../../utils/file-preview-format'
import type { WorkspaceFileProvider } from '../../composables/workspace-file-provider'
import { copyText } from '../../utils/clipboard'
import { ElMessage } from 'element-plus'
import { ChatDotRound, CopyDocument, Download, Refresh, View } from '@element-plus/icons-vue'

const props = defineProps<{
  filePath: string
  provider: WorkspaceFileProvider | null
  /** 从某个工作区目录的文件管理打开时，后续相对链接仍落在这个目录。 */
  workspaceRoot?: string
  /** 是否为 Agent 发送文件（send_file 会话副本）预览页签：隐藏工作区专属的「引用到对话」。 */
  isDelivery?: boolean
}>()

const emit = defineEmits<{
  'add-file-to-chat': [filePath: string]
}>()

const sessionStore = useSessionStore()
const activeSessionIdRef = computed(() => sessionStore.activeSessionId ?? '')
const { openFileTab } = useCenterTabs(activeSessionIdRef)

const { canShowInFinder, showInFinder } = useShowInFinder(
  () => props.provider,
  () => props.filePath,
)

type LoadState = 'loading' | 'ready' | 'error' | 'binary' | 'empty' | 'image' | 'pdf' | 'csv' | 'zip' | 'xlsx' | 'docx' | 'media'

const state = ref<LoadState>('loading')
const content = ref('')
const imageDataUri = ref('')
const pdfBlobUrl = ref('')
const pdfFileName = ref('')
/** 字节分支数据：zip / xlsx 共用，readFileBytes 成功后驻留，供 ArchiveBrowser / SpreadsheetView 消费（A1 早返回分支） */
const bytesData = ref<{ bytes: Uint8Array; name: string } | null>(null)
const monacoContainer = ref<HTMLElement>()
const viewMode = ref<'source' | 'rendered'>('rendered')
const { isDark } = useTheme()

const quoteFileRangeToChat = inject<((quote: FileRangeQuotePayload) => void) | null>('quoteFileRangeToChat', null)
let detachQuote: (() => void) | null = null
/** 屏幕上这份内容对应的修订号。去抖重载完成前不跟着实时修订号走。 */
const displayedQuoteRev = ref(0)

function currentQuoteRev(): number {
  if (props.isDelivery) return 0
  const workspace = sessionStore.activeSession?.workspace || ''
  if (!workspace || !sessionStore.fileQuoteRevision) return 0
  return sessionStore.fileQuoteRevision(workspace, props.filePath)
}

const isMarkdown = computed(() => {
  const ext = props.filePath.split('.').pop()?.toLowerCase()
  return ext === 'md' || ext === 'markdown'
})

const showSource = computed(() => !isMarkdown.value || viewMode.value === 'source')

const monacoEnabled = computed(() => state.value === 'ready' && showSource.value)

// 自动换行偏好：localStorage 记忆，下次打开沿用（键名对齐 aw-theme-mode 的 aw- 前缀惯例）。
// 经 globalThis 访问：node 环境测试（FileViewer.dispatch）无 localStorage，缺省按关闭处理。
const wordWrapOn = ref(globalThis.localStorage?.getItem('aw-file-word-wrap') === '1')
const wordWrapRef = computed(() => (wordWrapOn.value ? 'on' : 'off') as 'on' | 'off')

function toggleWordWrap() {
  wordWrapOn.value = !wordWrapOn.value
  globalThis.localStorage?.setItem('aw-file-word-wrap', wordWrapOn.value ? '1' : '0')
}

async function copyAll() {
  const ok = await copyText(content.value)
  if (ok) ElMessage.success('已复制全文')
  else ElMessage.error('复制失败，请手动选择复制')
}

async function downloadFile() {
  const name = props.filePath.split(/[/\\]/).pop() || props.filePath
  const result = await props.provider?.downloadFile?.(props.filePath, name)
  if (!result) return
  if (!result.ok) {
    ElMessage.error(result.error || '下载失败')
    return
  }
  if (!props.isDelivery && result.url && (isWechatBrowser() || isAndroidCapacitor())) {
    await openExternalUrl(result.url)
  }
}

useMonacoViewer({
  container: monacoContainer,
  content,
  filePath: toRef(props, 'filePath'),
  isDark,
  enabled: monacoEnabled,
  wordWrap: wordWrapRef,
  onEditor(editor) {
    detachQuote?.()
    detachQuote = null
    if (!editor || props.isDelivery || !quoteFileRangeToChat || isAndroidCapacitor()) return
    detachQuote = attachMonacoQuote({
      editor,
      getFilePath: () => props.filePath,
      getCapturedRevision: () => displayedQuoteRev.value,
      onQuote: (quote) => quoteFileRangeToChat?.(quote),
    })
  },
})

async function handleMarkdownClick(e: MouseEvent) {
  const anchor = (e.target as HTMLElement).closest('a')
  if (!anchor) return

  const href = anchor.getAttribute('href')
  if (!href) return

  e.preventDefault()

  if (isExternalMarkdownLink(href)) {
    // 兜底路径：正常情况下 document 级 externalLink 委托已在捕获阶段接管外链
    // （openExternalUrl），这里覆盖容器先于 document 收到点击的极端时序
    await openExternalUrl(href)
    return
  }

  if (props.isDelivery) return

  const resolvedPath = resolveMarkdownLink(props.filePath, href)
  if (!resolvedPath) return

  const title = resolvedPath.split(/[/\\]/).pop() || resolvedPath
  openFileTab(resolvedPath, title, props.workspaceRoot)
}

const totalLines = ref(0)
const errorMsg = ref('')
const truncated = ref(false)

function isBinaryContent(text: string): boolean {
  // Check first 8KB for null bytes
  const checkLen = Math.min(text.length, 8192)
  for (let i = 0; i < checkLen; i++) {
    if (text.charCodeAt(i) === 0) return true
  }
  return false
}

function releasePdfBlobUrl() {
  if (pdfBlobUrl.value) {
    URL.revokeObjectURL(pdfBlobUrl.value)
    pdfBlobUrl.value = ''
  }
}

function isPdfPath(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase()
  return ext === 'pdf'
}

// 文件读取请求序号：路径切换 / 重载时丢弃过期响应，防止旧响应覆盖当前标签内容。
// PDF 与文本/图片/新格式共用这一个序号——曾给 PDF 单开一个 pdfPreviewSeq，两个计数器
// 在 loadFile 里对齐（pdfPreviewSeq = loadFileSeq）后又被 loadPdfPreview 各自 ++，
// 序号碰撞让 PDF 的陈旧守卫失效：a.pdf 切到 b.zip 后迟到的 previewFile 会把界面
// 持久覆盖回 a.pdf（review round2 #1，本次新分支放大了该既有缺陷的触发面）。
let loadFileSeq = 0

function isStaleLoad(seq: number): boolean {
  return seq !== loadFileSeq
}

async function loadPdfPreview(seq: number) {
  if (!props.provider?.previewFile) {
    state.value = 'error'
    errorMsg.value = '当前模式不支持 PDF 预览'
    return
  }
  const result = await props.provider.previewFile(props.filePath)
  if (isStaleLoad(seq)) return
  if (result.error) {
    state.value = 'error'
    errorMsg.value = result.error
    return
  }
  if (!result.blob || result.blob.size === 0) {
    state.value = 'error'
    errorMsg.value = 'PDF 内容为空'
    return
  }
  releasePdfBlobUrl()
  pdfFileName.value = props.filePath.split(/[/\\]/).pop() || props.filePath
  pdfBlobUrl.value = URL.createObjectURL(result.blob)
  state.value = 'pdf'
}

async function loadBinaryPreview(seq: number, target: 'zip' | 'xlsx' | 'docx' | 'media') {
  if (!props.provider?.readFileBytes) {
    // project provider（新建态）无字节通道：明确降级，不做半吊子实现（技术方案 §5.2）
    state.value = 'error'
    errorMsg.value = '当前模式不支持预览该文件，请在会话工作区中打开'
    return
  }
  const result = await props.provider.readFileBytes(props.filePath)
  if (isStaleLoad(seq)) return
  if (result.error) {
    state.value = 'error'
    errorMsg.value = result.error
    return
  }
  if (!result.bytes || result.bytes.byteLength === 0) {
    state.value = 'error'
    errorMsg.value = '文件内容为空'
    return
  }
  bytesData.value = { bytes: result.bytes, name: props.filePath.split(/[/\\]/).pop() || props.filePath }
  state.value = target
}

async function loadFile() {
  if (!props.filePath) return
  if (!props.provider) {
    state.value = 'error'
    errorMsg.value = '工作区未就绪，请稍后再试'
    return
  }
  // 作废旧请求（PDF 与文本/图片共用序号：路径切换/重载时丢弃过期响应）
  const seq = ++loadFileSeq
  state.value = 'loading'
  content.value = ''
  imageDataUri.value = ''
  bytesData.value = null
  errorMsg.value = ''
  truncated.value = false

  try {
    if (isPdfPath(props.filePath)) {
      await loadPdfPreview(seq)
      return
    }

    const kind = resolvePreviewKind(props.filePath)

    // 二进制类新格式（zip/tar/tar.gz / xlsx / docx / media）：扩展名命中即在 readFile
    // 之前平行早返回，既有五条路径一行不动（技术方案 §6-A1）
    if (kind === 'zip' || kind === 'xlsx' || kind === 'docx' || kind === 'media') {
      await loadBinaryPreview(seq, kind)
      return
    }

    const revisionAtRead = currentQuoteRev()
    const result = await props.provider.readFile(props.filePath, { limit: 5000 })
    if (isStaleLoad(seq)) return

    if (result.error) {
      state.value = 'error'
      errorMsg.value = result.error
      return
    }

    if (result.media_type === 'image' && result.data_uri) {
      content.value = result.content
      imageDataUri.value = result.data_uri
      state.value = 'image'
      return
    }

    if (result.total_lines === 0 && !result.content) {
      state.value = 'empty'
      totalLines.value = 0
      return
    }

    // sniff 兜底（技术方案 §5.1 / §6-B7）：无扩展名或扩展名撒谎的 zip / xlsx，
    // LOCAL 的 readFile 能取到文本形式的 PK 魔数，改道字节分支；CLOUD 的 readFile
    // 遇二进制直接报错走不到这里（已知不对称，记录在案）。
    // 必须排在 binary 检查之前：真实 zip 本地文件头第 5 字节（version needed to
    // extract）必为 0x00，先跑 isBinaryContent 会把所有真实压缩包判成二进制，
    // 兜底 100% 不可达（review round1 #1 实测复现，原实现即此顺序）。
    const sniffed = kind === null ? sniffContainerKind(result.content) : null
    if (sniffed) {
      await loadBinaryPreview(seq, sniffed)
      return
    }

    // Binary detection
    if (isBinaryContent(result.content)) {
      state.value = 'binary'
      return
    }

    content.value = result.content
    totalLines.value = result.total_lines
    truncated.value = result.total_lines > 5000
    displayedQuoteRev.value = revisionAtRead
    // 文本类新格式（csv）只在 readFile 成功后的分支点改道表格渲染（技术方案 §6-A1）
    state.value = kind === 'csv' ? 'csv' : 'ready'
  } catch (e: any) {
    if (isStaleLoad(seq)) return
    state.value = 'error'
    errorMsg.value = e.message || '未知错误'
  }
}

onMounted(loadFile)

let changeDebounceTimer: ReturnType<typeof setTimeout> | null = null

watch(() => [props.filePath, props.provider] as const, () => {
  // Cancel pending change-triggered reload so navigation does not double-load
  if (changeDebounceTimer) {
    clearTimeout(changeDebounceTimer)
    changeDebounceTimer = null
  }
  releasePdfBlobUrl()
  loadFile()
})

// 同路径第二次编辑不会增加变更条数（appendFileChange 原地合并）。
// 重载看工作区修订号，预览里下一次引用才能拿到新内容。
const fileQuoteRev = computed(() => {
  if (props.isDelivery) return 0
  const workspace = sessionStore.activeSession?.workspace || ''
  if (!workspace || !sessionStore.fileQuoteRevision) return 0
  return sessionStore.fileQuoteRevision(workspace, props.filePath)
})

watch(
  () => ({ path: props.filePath, rev: fileQuoteRev.value }),
  (curr, prev) => {
    if (!prev || curr.path !== prev.path) return
    if (curr.rev > prev.rev) {
      if (changeDebounceTimer) clearTimeout(changeDebounceTimer)
      changeDebounceTimer = setTimeout(() => {
        loadFile()
      }, 300)
    }
  },
)

onUnmounted(() => {
  detachQuote?.()
  detachQuote = null
  if (changeDebounceTimer) {
    clearTimeout(changeDebounceTimer)
    changeDebounceTimer = null
  }
  releasePdfBlobUrl()
})
</script>

<style scoped>
.file-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--aw-surface);
}

.file-message {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-body);
}

.file-message.error {
  color: var(--aw-danger);
}

.file-message p {
  margin: 0 0 12px;
}

.file-message-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.image-preview {
  padding: 24px;
  gap: 12px;
}

.image-preview img {
  max-width: 100%;
  max-height: calc(100% - 48px);
  object-fit: contain;
  border-radius: var(--aw-radius-sm);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
}

.image-meta {
  margin: 12px 0 0 !important;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
}

.retry-btn {
  height: var(--aw-btn-height);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--aw-text-fine);
  color: var(--aw-primary);
  background: none;
  border: 1px solid var(--aw-primary);
  border-radius: var(--aw-radius-xs);
  padding: var(--aw-btn-padding);
  cursor: pointer;
}

.retry-btn:hover {
  background: var(--aw-primary-hover);
}

.retry-btn.primary {
  background: var(--aw-primary);
  color: var(--aw-on-primary);
}

.retry-btn.primary:hover {
  background: var(--aw-primary-focus);
}

.file-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
  min-height: 0;
}

.pdf-container {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.file-editor-area {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.monaco-container {
  width: 100%;
  height: 100%;
  position: relative;
}

.file-scroll {
  height: 100%;
  overflow: auto;
}

.viewer-toolbar {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  gap: 2px;
  z-index: 10;
  padding: 2px;
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-xs);
  backdrop-filter: blur(8px);
}

.view-switch {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 1px;
  border-radius: var(--aw-radius-xs);
  background: var(--aw-canvas-parchment);
}

.tool-btn {
  width: var(--aw-btn-height);
  height: var(--aw-btn-height);
  padding: 0;
  color: var(--aw-ink-muted-48);
  background: transparent;
  border: none;
  border-radius: var(--aw-radius-xs);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}

.tool-btn:hover {
  color: var(--aw-ink);
}

.tool-btn.active {
  color: var(--aw-primary);
  background: var(--aw-primary-hover);
}

.tool-icon {
  width: 14px;
  height: 14px;
  display: block;
}

.view-switch .tool-btn.active {
  background: var(--aw-surface);
  box-shadow: 0 0 0 1px var(--aw-divider-soft);
}

.markdown-body {
  flex: 1;
  padding: 16px 24px;
  overflow: auto;
  color: var(--aw-ink);
  font-size: var(--aw-text-caption);
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  font-family: var(--aw-font-display);
  font-weight: 600;
  color: var(--aw-ink);
  margin: 4px 0 2px;
  letter-spacing: var(--aw-tracking);
}

.markdown-body :deep(h1) { font-size: var(--aw-text-lead); }
.markdown-body :deep(h2) { font-size: var(--aw-text-tagline); }
.markdown-body :deep(h3) { font-size: var(--aw-text-body); }
.markdown-body :deep(h4) { font-size: var(--aw-text-caption); }

.markdown-body :deep(p) {
  margin: 0;
  font-size: var(--aw-text-caption);
  line-height: 2;
  letter-spacing: var(--aw-tracking);
}

.markdown-body :deep(a) {
  color: var(--aw-primary);
  text-decoration: none;
}

.markdown-body :deep(a:hover) { text-decoration: underline; }

.markdown-body :deep(code) {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
}

.markdown-body :deep(pre) {
  margin: 2px 0;
  border-radius: var(--aw-radius-sm);
  overflow: hidden;
}

.markdown-body :deep(.code-block) {
  margin: 2px 0;
  border-radius: var(--aw-radius-sm);
  overflow: hidden;
}

.markdown-body :deep(.code-block-header) {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  background: var(--aw-surface-code-header);
  border-bottom: 1px solid var(--aw-divider-soft);
  font-size: var(--aw-text-fine);
}

.markdown-body :deep(.code-lang) {
  color: var(--aw-ink-muted-48);
  font-family: var(--aw-font-mono);
  text-transform: uppercase;
  letter-spacing: var(--aw-tracking);
}

.markdown-body :deep(.code-copy-btn) {
  height: var(--aw-btn-height);
  background: none;
  border: 1px solid var(--aw-hairline);
  color: var(--aw-ink-muted-48);
  padding: var(--aw-btn-padding);
  border-radius: var(--aw-radius-xs);
  cursor: pointer;
  font-size: var(--aw-text-fine);
  transition: all 0.15s;
}

.markdown-body :deep(.code-copy-btn:hover) {
  color: var(--aw-ink);
  border-color: var(--aw-ink-muted-48);
}

.markdown-body :deep(.monaco-code) {
  display: block;
  padding: 12px;
  background: var(--aw-surface-code);
  color: var(--aw-text-code);
  overflow-x: auto;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  line-height: 20px;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 2px 0;
  padding-left: 20px;
}

.markdown-body :deep(li) {
  font-size: var(--aw-text-caption);
  line-height: 2;
  letter-spacing: var(--aw-tracking);
}

.markdown-body :deep(blockquote) {
  margin: 2px 0;
  padding: 4px 12px;
  border-left: 3px solid var(--aw-primary);
  color: var(--aw-ink-muted-80);
  background: var(--aw-canvas-parchment);
  border-radius: 0 var(--aw-radius-xs) var(--aw-radius-xs) 0;
}

.markdown-body :deep(table) {
  border-collapse: collapse;
  margin: 2px 0;
  width: 100%;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--aw-hairline);
  padding: 6px 10px;
  text-align: left;
  font-size: var(--aw-text-caption);
}

.markdown-body :deep(th) {
  background: var(--aw-canvas-parchment);
  font-weight: 600;
}

.markdown-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--aw-divider-soft);
  margin: 2px 0;
}

.truncation-notice {
  padding: 8px 16px;
  text-align: center;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
  border-top: 1px solid var(--aw-divider-soft);
  background: var(--aw-canvas-parchment);
}

/* Scrollbar */
.file-scroll::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.file-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.file-scroll::-webkit-scrollbar-thumb {
  background: var(--aw-hairline);
  border-radius: 3px;
}

/* Dark mode */
[data-theme="dark"] .truncation-notice {
  border-top-color: var(--aw-hairline);
  background: rgba(255, 255, 255, 0.03);
}
</style>
