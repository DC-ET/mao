<template>
  <el-tooltip
    :content="filePath"
    placement="top"
    :show-after="300"
    :popper-options="{ strategy: 'fixed' }"
    popper-class="file-reference-tag-tip"
  >
    <span class="file-reference-tag">
      📄 {{ label }}
    </span>
  </el-tooltip>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { fileReferenceLabel } from '../../utils/file-range-label'

const props = defineProps<{
  filePath: string
  lineStart?: number
  lineEnd?: number
}>()

// 与 tiptap 节点渲染 HTML 共用同一份标签格式化（utils/file-range-label）
const label = computed(() => fileReferenceLabel(props))
</script>

<style>
.file-reference-tag-tip {
  max-width: 400px;
  word-break: break-word;
}
</style>

<style scoped>
.file-reference-tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;
  line-height: 1.4;
  vertical-align: baseline;
  white-space: nowrap;
  background: var(--aw-tag-file);
  color: var(--aw-tag-file-ink);
}
</style>
