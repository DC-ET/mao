<template>
  <!-- Pending files -->
  <div v-if="pendingFiles.length > 0" class="pending-files">
    <div v-for="(item, idx) in pendingFiles" :key="idx" class="pending-file">
      <img v-if="item.previewUrl" :src="item.previewUrl" class="file-preview-img" />
      <el-icon v-else><Document /></el-icon>
      <span class="file-name">{{ item.file.name }}</span>
      <el-icon class="remove-file" :class="{ disabled: disabled }" role="button" aria-label="移除待发文件" @click="!disabled && removeFile(idx)"><Close /></el-icon>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Document, Close } from '@element-plus/icons-vue'

defineProps<{
  pendingFiles: { file: File; previewUrl: string }[]
  disabled: boolean
  removeFile: (index: number) => void
}>()
</script>
