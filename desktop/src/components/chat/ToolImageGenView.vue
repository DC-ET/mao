<template>
  <!-- generate_image / edit_image 富视图：prompt 头行 + 图片网格（点击放大 + 大小/mime 角标）。
       结果契约无顶层 media_type/data_uri，与既有 imagePreviewUrl 链路天然互斥。 -->
  <div class="tool-image-gen">
    <div v-if="view.prompt" class="prompt-line" :title="view.prompt">{{ view.prompt }}</div>
    <div class="image-grid">
      <div v-for="(item, i) in view.items" :key="i" class="image-cell">
        <el-image
          :src="item.url"
          :preview-src-list="previewList"
          :initial-index="i"
          fit="contain"
          lazy
          class="image-thumb"
          :preview-teleported="true"
          @click.stop
        >
          <template #error>
            <div class="image-error">
              <span class="error-text">图片不可达</span>
              <span v-if="item.path" class="error-path" :title="item.path">{{ item.path }}</span>
              <button v-if="item.path" class="error-copy-btn" title="复制路径" @click.stop="copyPath(item.path)">复制路径</button>
            </div>
          </template>
        </el-image>
        <div v-if="item.bytesLabel || item.mimeTag" class="image-meta">
          <span v-if="item.bytesLabel">{{ item.bytesLabel }}</span>
          <span v-if="item.bytesLabel && item.mimeTag">·</span>
          <span v-if="item.mimeTag">{{ item.mimeTag }}</span>
        </div>
      </div>
    </div>
    <div v-if="view.hiddenCount > 0" class="hidden-hint">
      共 {{ totalImages }} 张，其余 {{ view.hiddenCount }} 张略
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { copyText as copyToClipboard } from '../../utils/clipboard'
import type { ImageGenViewData } from '../../utils/toolRichView'

const props = defineProps<{
  view: ImageGenViewData
}>()

const previewList = computed(() => props.view.items.map(item => item.url))
const totalImages = computed(() => props.view.items.length + props.view.hiddenCount)

async function copyPath(path: string) {
  const ok = await copyToClipboard(path)
  if (ok) ElMessage.success('已复制')
  else ElMessage.error('复制失败')
}
</script>

<style scoped>
.tool-image-gen {
  margin-bottom: 8px;
}

/* prompt 头行：墨色，同 webPageView 标题/查询行口径（蓝色只留给交互态） */
.prompt-line {
  margin-bottom: 6px;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  color: var(--aw-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.image-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px;
}

.image-cell {
  min-width: 0;
}

.image-thumb {
  width: 100%;
  height: 160px;
  display: block;
  border-radius: var(--aw-radius-sm);
  background: var(--aw-surface-code);
  cursor: zoom-in;
}

/* el-image error 槽降级：LOCAL/反代下 /uploads/ 静态地址可能不可达，不白屏 */
.image-error {
  width: 100%;
  height: 160px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 8px;
  border-radius: var(--aw-radius-sm);
  background: var(--aw-surface-code);
  box-sizing: border-box;
}

.error-text {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted);
}

.error-path {
  max-width: 100%;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.error-copy-btn {
  background: none;
  border: none;
  color: var(--aw-primary);
  font-size: var(--aw-text-fine);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: var(--aw-radius-xs);
}

.error-copy-btn:hover {
  background: var(--aw-primary-hover);
}

.image-meta {
  margin-top: 2px;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
}

.hidden-hint {
  margin-top: 6px;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
}
</style>
