<template>
  <!-- Pending files -->
  <div v-if="pendingFiles.length > 0" class="pending-files">
    <div v-for="(item, idx) in pendingFiles" :key="idx" class="pending-file">
      <img v-if="item.previewUrl" :src="item.previewUrl" class="file-preview-img" />
      <el-icon v-else><Document /></el-icon>
      <span class="file-name">{{ item.file.name }}</span>
      <el-icon
        v-if="item.file.type.startsWith('image/')"
        class="annotate-file"
        :class="{ disabled: disabled }"
        role="button"
        aria-label="标注图片"
        title="标注图片"
        @click="!disabled && emit('annotate', idx)"
      ><EditPen /></el-icon>
      <el-icon class="remove-file" :class="{ disabled: disabled }" role="button" aria-label="移除待发文件" @click="!disabled && removeFile(idx)"><Close /></el-icon>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Document, Close, EditPen } from '@element-plus/icons-vue'

defineProps<{
  pendingFiles: { file: File; previewUrl: string; localPath?: string; originalFile?: File }[]
  disabled: boolean
  removeFile: (index: number) => void
}>()

// 图片轻标注（技术方案 docs/plan/2026-11-10-rich-paste-annotate-technical-design.md §4.5）：
// 仅图片条目渲染标注按钮；全部执行模式可用（图片发送通道无模式分支，见方案 §8-6）
const emit = defineEmits<{
  annotate: [index: number]
}>()
</script>
