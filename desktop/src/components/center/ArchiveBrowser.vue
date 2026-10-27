<template>
  <div class="archive-browser">
    <div class="archive-toolbar">
      <span class="archive-file-name" :title="filePath">{{ fileName }}</span>
      <span v-if="state === 'ready'" class="archive-meta">{{ entryCountLabel }}</span>
      <span class="archive-toolbar-spacer"></span>
      <button class="tool-btn" title="刷新" @click="$emit('refresh')">
        <el-icon :size="14"><Refresh /></el-icon>
      </button>
      <button
        v-if="provider?.downloadFile"
        class="tool-btn"
        title="下载"
        @click="download"
      >
        <el-icon :size="14"><Download /></el-icon>
      </button>
    </div>

    <div v-if="state === 'loading'" class="archive-message">
      <p>正在解析压缩包…</p>
    </div>

    <div v-else-if="state === 'error'" class="archive-message error">
      <p>无法浏览该压缩包：{{ errorMsg }}</p>
      <button v-if="provider?.downloadFile" class="retry-btn" @click="download">下载后在本地查看</button>
      <!-- LOCAL 无 downloadFile：降级态至少给个定位出口，别成死路 -->
      <button v-else-if="canShowInFinder" class="retry-btn" @click="showInFinder">在 Finder 中显示</button>
    </div>

    <div v-else-if="state === 'ready'" class="archive-body">
      <p v-if="hasTooLargeEntries" class="archive-warn">
        部分条目过大已置灰，仅支持整包下载
      </p>
      <!-- 条目解压失败：jszip 对损坏 deflate 流抛错，只写 errorMsg 会在 ready 态
           无处渲染（点完好中央目录的损坏 zip 时表现为「点击没反应」） -->
      <p v-if="entryError" class="archive-warn archive-entry-error">
        条目读取失败：{{ entryError }}
      </p>
      <div class="archive-scroll">
        <button
          v-for="entry in entries"
          :key="entry.name"
          class="archive-entry"
          :class="{ dir: entry.isDirectory, disabled: entry.isDirectory || entry.tooLarge }"
          :disabled="entry.isDirectory || entry.tooLarge"
          :title="entry.name"
          @click="openEntry(entry)"
        >
          <span class="entry-icon">
            <el-icon :size="14">
              <Folder v-if="entry.isDirectory" />
              <Document v-else />
            </el-icon>
          </span>
          <span class="entry-name">{{ entry.displayName }}</span>
          <span v-if="entry.tooLarge" class="entry-badge">过大</span>
          <span class="entry-size">{{ entry.isDirectory ? '—' : formatSize(entry.uncompressedSize) }}</span>
          <span class="entry-ratio">{{ entry.isDirectory ? '' : compressionRatio(entry.compressedSize, entry.uncompressedSize) }}</span>
        </button>
      </div>
    </div>

    <!-- 条目内嵌预览覆盖层（技术方案 §5.4 / §6-D3）：不开新 tab，状态组件内管理 -->
    <div v-if="preview" class="archive-preview">
      <div class="preview-toolbar">
        <button class="tool-btn" title="返回条目列表" @click="closePreview">
          <el-icon :size="14"><Back /></el-icon>
        </button>
        <span class="preview-name" :title="preview.name">{{ preview.name }}</span>
        <span class="preview-label">压缩包内预览</span>
      </div>
      <div class="preview-body">
        <img v-if="preview.kind === 'image'" :src="preview.url" :alt="preview.name" />
        <PdfViewer
          v-else-if="preview.kind === 'pdf'"
          :blob-url="preview.url"
          :file-path="preview.name"
          :file-name="preview.name"
          :provider="null"
        />
        <pre v-else-if="preview.kind === 'text'">{{ preview.content }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { Back, Document, Download, Folder, Refresh } from '@element-plus/icons-vue'
import PdfViewer from './PdfViewer.vue'
import {
  evaluateArchive,
  classifyArchiveEntry,
  compressionRatio,
  displayNameOf,
  ZIP_TEXT_PREVIEW_MAX_BYTES,
  type ArchiveEntry,
} from '../../utils/archive-entries'
import { formatSize } from '../../utils/file-manager'
import { useShowInFinder } from '../../composables/useShowInFinder'
import type { WorkspaceFileProvider } from '../../composables/workspace-file-provider'
import type JSZip from 'jszip'

const props = defineProps<{
  filePath: string
  fileName: string
  bytes: Uint8Array
  provider: WorkspaceFileProvider | null
}>()

defineEmits<{
  refresh: []
}>()

const { canShowInFinder, showInFinder } = useShowInFinder(
  () => props.provider,
  () => props.filePath,
)

type LoadState = 'loading' | 'ready' | 'error'
type PreviewState =
  | { kind: 'image'; name: string; url: string }
  | { kind: 'pdf'; name: string; url: string }
  | { kind: 'text'; name: string; content: string }
  | null

const state = ref<LoadState>('loading')
const errorMsg = ref('')
/** 条目级（非整包）失败：ready 态下渲染的行内横幅，不把用户踢出条目列表 */
const entryError = ref('')
const entries = ref<ArchiveEntry[]>([])
const hasTooLargeEntries = ref(false)
const preview = ref<PreviewState>(null)
const zip = shallowRef<JSZip | null>(null)
const entryCountLabel = computed(() => `${entries.value.length} 个条目`)

// 压缩包加载与条目解压各自代际守卫：快速切换 / 连点时丢弃过期响应（§6-A2 / D2）
let loadSeq = 0
let entrySeq = 0

/** jszip 动态 import：库本体不进首屏主 chunk（§6-C1） */
async function loadArchive() {
  const seq = ++loadSeq
  state.value = 'loading'
  preview.value = null
  entries.value = []
  hasTooLargeEntries.value = false
  errorMsg.value = ''
  entryError.value = ''
  try {
    const { default: JSZip } = await import('jszip')
    const loaded = await JSZip.loadAsync(props.bytes)
    if (seq !== loadSeq) return
    zip.value = loaded
    const evaluation = evaluateArchive(extractEntries(loaded))
    if (evaluation.rejected) {
      state.value = 'error'
      errorMsg.value = evaluation.rejected
      return
    }
    entries.value = evaluation.entries
    hasTooLargeEntries.value = evaluation.hasTooLargeEntries
    state.value = 'ready'
  } catch (e: any) {
    if (seq !== loadSeq) return
    // zip64（>4GB）/ 畸形包：JSZip 加载失败即降级下载（§12 残余风险）
    state.value = 'error'
    errorMsg.value = e?.message || '压缩包解析失败'
  }
}

/** 中央目录抽取：只读 _data 的声明大小，不解压任何内容（zip 炸弹前提）。 */
function extractEntries(loaded: JSZip) {
  const raw: Array<{ name: string; isDirectory: boolean; uncompressedSize: number; compressedSize: number }> = []
  loaded.forEach((_path: string, file: JSZip.JSZipObject) => {
    // jszip 的 _data 是私有字段（类型声明里注释掉），中央目录大小只能从这里取
    const data = (file as unknown as { _data?: { uncompressedSize?: number; compressedSize?: number } })._data
    raw.push({
      name: file.name,
      isDirectory: !!file.dir,
      uncompressedSize: data?.uncompressedSize ?? 0,
      compressedSize: data?.compressedSize ?? 0,
    })
  })
  return raw
}

async function openEntry(entry: ArchiveEntry) {
  const target = zip.value?.file(entry.name)
  if (!target) return
  const seq = ++entrySeq
  const kind = classifyArchiveEntry(entry.name)
  entryError.value = ''
  try {
    if (kind === 'text') {
      // 超大文本不进 <pre>：超过软上限降级下载，避免渲染进程被冻住
      if (entry.uncompressedSize > ZIP_TEXT_PREVIEW_MAX_BYTES) {
        await downloadEntry(entry)
        return
      }
      const content = await target.async('text')
      if (seq !== entrySeq) return
      releasePreviewUrl()
      preview.value = { kind: 'text', name: entry.displayName, content }
      return
    }
    if (kind === 'other') {
      await downloadEntry(entry)
      return
    }
    const bytes = await target.async('uint8array')
    if (seq !== entrySeq) return
    const url = replacePreviewUrl(bytes, entry.name)
    preview.value =
      kind === 'image'
        ? { kind: 'image', name: entry.displayName, url }
        : { kind: 'pdf', name: entry.displayName, url }
  } catch (e: any) {
    if (seq !== entrySeq) return
    // 条目数据损坏（jszip: uncompressed data size mismatch / invalid distance 等）：
    // state 仍是 ready，错误必须落在 ready 态可见的行内横幅，否则点击毫无反馈
    entryError.value = e?.message || '条目读取失败'
  }
}

/** 单条目下载：整包下载之外的「其他」类型与超大文本的出口。 */
async function downloadEntry(entry: ArchiveEntry) {
  const target = zip.value?.file(entry.name)
  if (!target) return
  const bytes = await target.async('uint8array')
  const blob = new Blob([bytes as BlobPart])
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  // 下载名取末段：条目名里的目录分隔与 ../ 不进文件名
  a.download = displayNameOf(entry.name, false)
  a.click()
  URL.revokeObjectURL(url)
}

let previewUrl = ''

function releasePreviewUrl() {
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl)
    previewUrl = ''
  }
}

/** 换条目预览：先释放上一个 blob URL 再建新的（§6-D1 / A5） */
function replacePreviewUrl(bytes: Uint8Array, name: string): string {
  releasePreviewUrl()
  const mime = mimeOf(name)
  previewUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
  return previewUrl
}

function mimeOf(name: string): string {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (ext === 'svg') return 'image/svg+xml'
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'bmp') return 'image/bmp'
  if (ext === 'ico') return 'image/x-icon'
  if (ext === 'pdf') return 'application/pdf'
  return 'application/octet-stream'
}

function closePreview() {
  preview.value = null
  releasePreviewUrl()
  entryError.value = ''
}

async function download() {
  await props.provider?.downloadFile?.(props.filePath, props.fileName)
}

// 防御性 watch：FileViewer 的刷新路径是「bytesData 置 null → 子组件卸载 → 新 bytes
// 重挂」，同一实例上 bytes 不会变，正常情况下这里不触发；真被传新 bytes 时重走加载
watch(
  () => props.bytes,
  () => {
    void loadArchive()
  },
)

onMounted(async () => {
  await nextTick()
  await loadArchive()
})

onUnmounted(() => {
  releasePreviewUrl()
})
</script>

<style scoped>
.archive-browser {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  position: relative;
}

.archive-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--aw-divider-soft);
  background: var(--aw-surface);
}

.archive-file-name {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.archive-meta {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  white-space: nowrap;
}

.archive-toolbar-spacer {
  flex: 1;
}

.tool-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--aw-btn-height);
  height: var(--aw-btn-height);
  padding: 0;
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-xs);
  cursor: pointer;
  color: var(--aw-ink-muted-48);
  transition: all 0.15s;
}

.tool-btn:hover {
  color: var(--aw-ink);
}

.archive-message {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-caption);
}

.archive-message.error {
  color: var(--aw-danger);
}

.archive-message p {
  margin: 0 0 12px;
}

.retry-btn {
  height: var(--aw-btn-height);
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

.archive-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.archive-warn {
  margin: 0;
  padding: 8px 12px;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  background: var(--aw-canvas-parchment);
  border-bottom: 1px solid var(--aw-divider-soft);
}

.archive-entry-error {
  color: var(--aw-danger);
}

.archive-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.archive-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  background: none;
  border: none;
  border-bottom: 1px solid var(--aw-divider-soft);
  cursor: pointer;
  text-align: left;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink);
}

.archive-entry:hover:not(.disabled) {
  background: var(--aw-primary-hover);
}

.archive-entry.disabled {
  color: var(--aw-ink-muted-48);
  cursor: default;
}

.archive-entry.dir {
  color: var(--aw-ink-muted-80);
  font-weight: 600;
}

.entry-icon {
  display: inline-flex;
  flex: none;
}

.entry-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entry-badge {
  flex: none;
  font-size: var(--aw-text-fine);
  color: var(--aw-danger);
  border: 1px solid var(--aw-danger);
  border-radius: var(--aw-radius-xs);
  padding: 0 4px;
}

.entry-size {
  flex: none;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  font-variant-numeric: tabular-nums;
}

.entry-ratio {
  flex: none;
  width: 44px;
  text-align: right;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  font-variant-numeric: tabular-nums;
}

.archive-preview {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  background: var(--aw-surface);
}

.preview-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--aw-divider-soft);
  background: var(--aw-surface);
}

.preview-name {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-label {
  flex: none;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
}

.preview-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
}

.preview-body img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  margin: auto;
  padding: 16px;
}

.preview-body pre {
  flex: 1;
  margin: 0;
  padding: 16px 24px;
  overflow: auto;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  line-height: 1.6;
  color: var(--aw-ink);
  white-space: pre-wrap;
  word-break: break-all;
}

/* Scrollbar */
.archive-scroll::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.archive-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.archive-scroll::-webkit-scrollbar-thumb {
  background: var(--aw-hairline);
  border-radius: 3px;
}
</style>
