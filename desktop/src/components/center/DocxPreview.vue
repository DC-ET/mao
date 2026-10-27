<template>
  <div class="docx-preview">
    <div class="docx-toolbar">
      <span class="docx-file-name" :title="filePath">{{ fileName }}</span>
      <span class="docx-toolbar-spacer"></span>
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

    <div v-if="state === 'loading'" class="docx-message">
      <p>正在解析文档…</p>
    </div>

    <div v-else-if="state === 'error'" class="docx-message error">
      <p>{{ errorMsg }}</p>
      <button v-if="provider?.downloadFile" class="retry-btn" @click="download">下载后在本地查看</button>
      <!-- LOCAL 无 downloadFile：降级态至少给个定位出口，别成死路 -->
      <button v-else-if="canShowInFinder" class="retry-btn" @click="showInFinder">在 Finder 中显示</button>
    </div>

    <div v-else-if="state === 'ready'" class="docx-scroll">
      <!-- 本方案唯一 v-html：mammoth 输出过主链同款 DOMPurify 选项（§5.6 / F1） -->
      <div class="markdown-body" v-html="sanitizedHtml"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { Download, Refresh } from '@element-plus/icons-vue'
import DOMPurify from 'dompurify'
import { ensureExternalLinkDelegation } from '../../utils/externalLink'
import { useShowInFinder } from '../../composables/useShowInFinder'
import type { WorkspaceFileProvider } from '../../composables/workspace-file-provider'

const props = defineProps<{
  filePath: string
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

/** 文件字节上限（§5.6）：超过降级下载，不解析 */
const DOCX_MAX_BYTES = 10 * 1024 * 1024

// 与 useMarkdown.ts:138 主链 SANITIZE_OPTIONS 同口径：默认白名单 + target 属性
const SANITIZE_OPTIONS = { ADD_ATTR: ['target'] }

type LoadState = 'loading' | 'ready' | 'error'

const state = ref<LoadState>('loading')
const errorMsg = ref('')
const sanitizedHtml = ref('')

// 加载代际守卫：快速切换文件 / 连点刷新时丢弃过期响应（§6-A2）
let loadSeq = 0

async function load() {
  const seq = ++loadSeq
  state.value = 'loading'
  errorMsg.value = ''
  sanitizedHtml.value = ''
  // 字节上限先行：超大文档不交给 mammoth 解析（§5.6）
  if (props.bytes.byteLength > DOCX_MAX_BYTES) {
    state.value = 'error'
    errorMsg.value = '文档过大，请下载后查看'
    return
  }
  try {
    // mammoth 动态 import：库本体不进首屏主 chunk（§6-C1）
    const { default: Mammoth } = await import('mammoth')
    const result = await Mammoth.convertToHtml({ arrayBuffer: toArrayBuffer(props.bytes) })
    if (seq !== loadSeq) return
    // mammoth 输出过主链同款消毒后才进 v-html（F1：全方案唯一 v-html）
    sanitizedHtml.value = DOMPurify.sanitize(result.value, SANITIZE_OPTIONS)
    // mammoth 产出的外链交给 document 级委托统一走 openExternalUrl（同 Markdown 主链）
    ensureExternalLinkDelegation()
    state.value = 'ready'
  } catch (e: any) {
    if (seq !== loadSeq) return
    // 加密 / 畸形 docx：mammoth 解析失败即降级下载（§5.6）
    state.value = 'error'
    errorMsg.value = e?.message || '文档解析失败'
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // 视图可能只是底层 buffer 的一段：按视图边界裁出独立 ArrayBuffer
  // （TS 5.7+ 下 buffer 类型是 ArrayBufferLike，运行时来自 IPC / fetch 的都是
  // 普通 ArrayBuffer， SharedArrayBuffer 不进这条链路）
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer
  }
  return bytes.slice().buffer
}

const fileName = computed(() => props.filePath.split(/[/\\]/).pop() || props.filePath)

async function download() {
  await props.provider?.downloadFile?.(props.filePath, fileName.value)
}

// 防御性 watch：FileViewer 的刷新路径是「bytesData 置 null → 子组件卸载 → 新 bytes
// 重挂」，同一实例上 bytes 不会变，正常情况下这里不触发；真被传新 bytes 时重走加载
watch(
  () => props.bytes,
  () => {
    void load()
  },
)

onMounted(async () => {
  await nextTick()
  await load()
})
</script>

<style scoped>
.docx-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  position: relative;
}

.docx-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--aw-divider-soft);
  background: var(--aw-surface);
}

.docx-file-name {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.docx-toolbar-spacer {
  flex: 1;
}

.tool-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: var(--aw-btn-height);
  padding: 0 var(--aw-btn-padding);
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-xs);
  cursor: pointer;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-fine);
  transition: all 0.15s;
}

.tool-btn:hover {
  color: var(--aw-ink);
}

.docx-message {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-body);
}

.docx-message.error {
  color: var(--aw-danger);
}

.docx-message p {
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

.docx-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

/* docx 富文本排版：mammoth 产出 h1-h6 / p / table / list / blockquote / img。
   v-html 内容不带 scoped 属性，子级选择器必须 :deep()（同 FileViewer 口径） */
.markdown-body {
  padding: 16px 24px;
  color: var(--aw-ink);
  font-size: var(--aw-text-caption);
  line-height: 1.8;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4),
.markdown-body :deep(h5),
.markdown-body :deep(h6) {
  font-family: var(--aw-font-display);
  font-weight: 600;
  color: var(--aw-ink);
  margin: 12px 0 4px;
  line-height: 1.4;
}

.markdown-body :deep(h1) { font-size: var(--aw-text-lead); }
.markdown-body :deep(h2) { font-size: var(--aw-text-tagline); }
.markdown-body :deep(h3) { font-size: var(--aw-text-body); }
.markdown-body :deep(h4),
.markdown-body :deep(h5),
.markdown-body :deep(h6) { font-size: var(--aw-text-caption); }

.markdown-body :deep(p) {
  margin: 0 0 8px;
}

.markdown-body :deep(a) {
  color: var(--aw-primary);
  text-decoration: none;
}

.markdown-body :deep(a:hover) {
  text-decoration: underline;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 4px 0;
  padding-left: 24px;
}

.markdown-body :deep(li) {
  margin: 2px 0;
}

.markdown-body :deep(blockquote) {
  margin: 4px 0;
  padding: 4px 12px;
  border-left: 3px solid var(--aw-primary);
  color: var(--aw-ink-muted-80);
  background: var(--aw-canvas-parchment);
  border-radius: 0 var(--aw-radius-xs) var(--aw-radius-xs) 0;
}

.markdown-body :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: var(--aw-radius-sm);
}

.markdown-body :deep(table) {
  border-collapse: collapse;
  margin: 8px 0;
  width: 100%;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--aw-hairline);
  padding: 6px 10px;
  text-align: left;
}

.markdown-body :deep(th) {
  background: var(--aw-canvas-parchment);
  font-weight: 600;
}

.markdown-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--aw-divider-soft);
  margin: 12px 0;
}
</style>
