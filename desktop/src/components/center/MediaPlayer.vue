<template>
  <div class="media-player">
    <div class="media-toolbar">
      <span class="media-file-name" :title="filePath">{{ fileName }}</span>
      <span v-if="tooLarge" class="media-warn">文件较大（{{ sizeLabel }}），已转为下载</span>
      <template v-else-if="state === 'ready'">
        <span class="media-meta">{{ kindLabel }} · {{ sizeLabel }}</span>
        <span v-if="codecHint" class="media-hint-inline" :title="codecHint">{{ codecHint }}</span>
      </template>
      <span class="media-toolbar-spacer"></span>
      <button class="tool-btn" title="刷新" @click="$emit('refresh')">
        <el-icon :size="14"><Refresh /></el-icon>
      </button>
      <button v-if="provider?.downloadFile" class="tool-btn" title="下载" @click="download">
        <el-icon :size="14"><Download /></el-icon>
      </button>
      <button
        v-else-if="canShowInFinder"
        class="tool-btn text"
        title="在 Finder 中显示"
        @click="showInFinder"
      >
        在 Finder 中显示
      </button>
    </div>

    <div v-if="tooLarge" class="media-message">
      <p>文件较大（{{ sizeLabel }}），已转为下载</p>
      <p class="media-hint">超过 {{ maxSizeLabel }} 的文件不直接播放，避免长时间占用内存</p>
    </div>

    <div v-else-if="state === 'error'" class="media-message error">
      <p>{{ errorMsg }}</p>
      <button v-if="provider?.downloadFile" class="retry-btn" @click="download">下载后在本地查看</button>
      <button v-else-if="canShowInFinder" class="retry-btn" @click="showInFinder">在 Finder 中显示</button>
    </div>

    <div v-else-if="state === 'ready'" class="media-stage">
      <video
        v-if="kind === 'video'"
        ref="mediaEl"
        class="media-el"
        :src="blobUrl"
        controls
        preload="metadata"
        @error="onMediaError"
      />
      <audio
        v-else
        ref="mediaEl"
        class="media-el audio"
        :src="blobUrl"
        controls
        preload="metadata"
        @error="onMediaError"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { Download, Refresh } from '@element-plus/icons-vue'
import { MEDIA_MAX_BYTES, isCodecDependent, mediaKindOf, mediaMimeOf } from '../../utils/media-format'
import { formatSize } from '../../utils/file-manager'
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

type LoadState = 'loading' | 'ready' | 'error'

const state = ref<LoadState>('loading')
const errorMsg = ref('')
const blobUrl = ref('')
const mediaEl = ref<HTMLMediaElement | null>(null)

const fileName = computed(() => props.filePath.split(/[/\\]/).pop() || props.filePath)
const kind = computed(() => mediaKindOf(props.filePath))
const kindLabel = computed(() => (kind.value === 'video' ? '视频' : '音频'))
const sizeLabel = computed(() => formatSize(props.bytes.byteLength))
const maxSizeLabel = computed(() => formatSize(MEDIA_MAX_BYTES))
/** 超过播放上限（决策 5）：不建 blob URL，转下载 / Finder 显示 */
const tooLarge = computed(() => props.bytes.byteLength > MEDIA_MAX_BYTES)

/**
 * 编解码依赖标注（技术方案 §6-G2 ★）：Electron 官方构建不含 H.264/AAC 专有编解码，
 * mp4 / mov 可能「有声音黑屏」或直接 error。白名单已优先 webm/ogg/wav，这两个容器
 * 仍需常驻提示 + 播放失败时给出一键下载出口。
 */
const codecHint = computed(() =>
  !tooLarge.value && isCodecDependent(props.filePath) ? '依赖编解码支持，播放失败可点下载' : '',
)

/** LOCAL 下「在 Finder 中显示」：Electron 既有 IPC（preload.cjs:55），CLOUD 无此能力 */
const { canShowInFinder, showInFinder } = useShowInFinder(
  () => props.provider,
  () => props.filePath,
)

function pauseMedia() {
  mediaEl.value?.pause()
}

function releaseBlobUrl() {
  if (blobUrl.value) {
    URL.revokeObjectURL(blobUrl.value)
    blobUrl.value = ''
  }
}

function ensureBlobUrl() {
  if (blobUrl.value || tooLarge.value || props.bytes.byteLength === 0) return
  try {
    blobUrl.value = URL.createObjectURL(new Blob([props.bytes as BlobPart], { type: mediaMimeOf(props.filePath) }))
    state.value = 'ready'
  } catch (e: any) {
    state.value = 'error'
    errorMsg.value = e?.message || '媒体加载失败'
  }
}

function load() {
  pauseMedia()
  releaseBlobUrl()
  state.value = 'loading'
  errorMsg.value = ''
  if (tooLarge.value) {
    // 超限即转下载（§5.7）：LOCAL 无 downloadFile，留给 Finder 按钮手动处理
    void props.provider?.downloadFile?.(props.filePath, fileName.value)
    return
  }
  if (props.bytes.byteLength === 0) {
    state.value = 'error'
    errorMsg.value = '文件内容为空'
    return
  }
  ensureBlobUrl()
}

async function download() {
  await props.provider?.downloadFile?.(props.filePath, fileName.value)
}

/** 播放失败（缺编解码 / 数据损坏）：落到错误态，文案给出下载出口（§6-G2） */
function onMediaError() {
  state.value = 'error'
  errorMsg.value = '播放失败：当前环境可能缺少所需编解码器，可下载后用本地播放器打开'
  // 元素已从 DOM 摘掉，blob URL 没有消费者：及时释放，别白占最多 50MB 内存
  releaseBlobUrl()
}

// FileViewer 刷新会造新 bytes 对象：watch 到即重建 blob URL（§6-A3 变更重载）
watch(
  () => props.bytes,
  () => {
    load()
  },
)

// KeepAlive 标签切换：暂停播放并释放 blob URL（§5.7 生命周期纪律），
// 回到前台按需重建（bytes 仍由 props 持有）
onDeactivated(() => {
  pauseMedia()
  releaseBlobUrl()
})

onActivated(() => {
  if (state.value === 'ready' && !blobUrl.value) ensureBlobUrl()
})

onMounted(() => {
  load()
})

// 卸载放在 before 钩子：组件卸载时 Vue 先卸载 subTree 再跑 onUnmounted，
// 那时 mediaEl 已被置空，暂停会静默失效
onBeforeUnmount(() => {
  pauseMedia()
  releaseBlobUrl()
})
</script>

<style scoped>
.media-player {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  position: relative;
  background: var(--aw-surface);
}

.media-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--aw-divider-soft);
  background: var(--aw-surface);
}

.media-file-name {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.media-meta {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  white-space: nowrap;
}

.media-warn {
  font-size: var(--aw-text-fine);
  color: var(--aw-danger);
  white-space: nowrap;
}

.media-hint-inline {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.media-toolbar-spacer {
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

.media-message {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-body);
}

.media-message.error {
  color: var(--aw-danger);
}

.media-message p {
  margin: 0 0 8px;
}

.media-hint {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
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

.media-stage {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: #000;
}

.media-el {
  max-width: 100%;
  max-height: 100%;
}

.media-el.audio {
  width: min(480px, 100%);
}
</style>
