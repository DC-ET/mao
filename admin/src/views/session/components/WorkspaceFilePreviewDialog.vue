<template>
  <!-- 文件预览独立弹窗：与目录列表分离，避免两者纵向堆叠把弹窗顶高 -->
  <el-dialog
    :model-value="visible"
    width="960px"
    top="6vh"
    append-to-body
    destroy-on-close
    class="workspace-file-preview-dialog"
    @update:model-value="$emit('update:visible', $event)"
  >
    <template #header>
      <div class="wfp-header">
        <span class="wfp-title" :title="preview?.path">{{ preview?.path ?? '文件预览' }}</span>
        <div class="wfp-actions">
          <template v-if="preview?.data && preview.isMarkdown">
            <el-button text size="small" :type="preview.markdownRendered ? 'primary' : 'default'" @click="setMarkdownView(true)">渲染态</el-button>
            <el-button text size="small" :type="!preview.markdownRendered ? 'primary' : 'default'" @click="setMarkdownView(false)">源码</el-button>
          </template>
          <el-button v-if="preview" text size="small" type="primary" @click="onDownloadPath(preview.path)">下载</el-button>
        </div>
      </div>
    </template>

    <div class="wfp-body" v-loading="preview?.loading">
      <div v-if="!preview" class="wfp-empty">未选择文件</div>
      <div v-else-if="preview.loading" class="wfp-empty">加载中…</div>
      <template v-else-if="preview.error">
        <div class="wfp-preview-error">
          <div>暂不支持预览，请下载后查看</div>
          <div class="wfp-preview-error-detail">{{ preview.error }}</div>
        </div>
      </template>
      <template v-else-if="preview.pdfUrl">
        <iframe class="wfp-pdf" :src="preview.pdfUrl" :title="preview.path" />
      </template>
      <template v-else-if="preview.data?.media_type === 'image'">
        <div class="wfp-image-summary">{{ preview.data.content }}</div>
        <img class="wfp-image" :src="preview.data.data_uri" :alt="preview.path" />
      </template>
      <template v-else-if="preview.data">
        <div v-if="preview.isMarkdown && preview.markdownRendered" class="markdown-body wfp-markdown" v-html="renderMarkdown(preview.data.content)" />
        <pre v-else class="wfp-text">{{ preview.data.content }}</pre>
        <div v-if="textTruncated" class="wfp-truncated">仅显示前 {{ textDisplayedLines }} 行 / 共 {{ preview.data.total_lines }} 行</div>
      </template>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { renderMarkdown } from '../composables/useMarkdown'
import type { WorkspaceFilesController } from '../composables/useWorkspaceFiles'

const props = defineProps<{
  visible: boolean
  files: WorkspaceFilesController
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
}>()

const files = props.files
const preview = computed(() => files.state.preview)

const textDisplayedLines = computed(() => {
  const data = files.state.preview?.data
  if (data == null || data.media_type != null) return 0
  return data.content.length === 0 ? 0 : data.content.split('\n').length
})

const textTruncated = computed(() => {
  const p = files.state.preview
  return p?.data != null && p.data.media_type == null && textDisplayedLines.value < p.data.total_lines
})

function setMarkdownView(rendered: boolean) {
  const p = files.state.preview
  if (p && p.markdownRendered !== rendered) {
    files.toggleMarkdownView()
  }
}

async function onDownloadPath(path: string) {
  try {
    await files.downloadFile(path)
  } catch (e) {
    ElMessage.error((e as Error)?.message || '下载失败')
  }
}
</script>

<style scoped>
.workspace-file-preview-dialog :deep(.el-dialog) {
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  margin-bottom: 0 !important;
}

.workspace-file-preview-dialog :deep(.el-dialog__body) {
  min-height: 0;
  overflow: hidden;
}

.wfp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-width: 0;
}

.wfp-title {
  font-size: 14px;
  font-weight: 600;
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wfp-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.wfp-body {
  display: flex;
  flex-direction: column;
  min-height: 240px;
  max-height: 68vh;
  overflow: auto;
}

.wfp-empty {
  padding: 24px;
  text-align: center;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.wfp-truncated {
  padding: 6px 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.wfp-preview-error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  padding: 10px;
}

.wfp-preview-error-detail {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.wfp-text {
  margin: 0;
  padding: 10px;
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--el-fill-color-light);
  border-radius: 4px;
}

.wfp-image-summary {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.wfp-image {
  max-width: 100%;
  max-height: 56vh;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
}

.wfp-pdf {
  width: 100%;
  height: 64vh;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
}

/* Markdown 渲染态复用聊天记录样式（marked + DOMPurify 产物） */
.wfp-markdown :deep(p) {
  margin: 4px 0;
  font-size: 13px;
  line-height: 1.8;
}

.wfp-markdown :deep(pre) {
  margin: 4px 0;
  border-radius: 4px;
  overflow: hidden;
}

.wfp-markdown :deep(.code-block-header) {
  display: flex;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--el-fill-color);
  font-size: 12px;
}

.wfp-markdown :deep(code) {
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-size: 12px;
}

.wfp-markdown :deep(.hljs) {
  padding: 12px;
  background: var(--el-fill-color-light);
}

@media (max-width: 768px) {
  .workspace-file-preview-dialog :deep(.el-dialog) {
    width: calc(100vw - 24px) !important;
    max-height: 92vh;
  }

  .wfp-body {
    max-height: 60vh;
  }
}
</style>
